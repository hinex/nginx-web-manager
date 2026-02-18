/**
 * Minimal tar archive creation and extraction.
 *
 * Implements the POSIX UStar format: 512-byte headers followed by
 * content padded to 512-byte boundaries. No external dependencies.
 */

const BLOCK_SIZE = 512;

interface TarEntry {
  name: string;
  content: Buffer;
}

/**
 * Compute the tar header checksum.
 * The checksum is the sum of all bytes in the header, with the
 * checksum field itself treated as spaces (0x20).
 */
function computeChecksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    // Bytes 148-155 are the checksum field, treated as spaces
    if (i >= 148 && i < 156) {
      sum += 0x20;
    } else {
      sum += header[i];
    }
  }
  return sum;
}

/**
 * Write a null-terminated octal string into a buffer at the given offset.
 */
function writeOctal(buf: Buffer, value: number, offset: number, length: number): void {
  const str = value.toString(8).padStart(length - 1, "0");
  buf.write(str, offset, length - 1, "ascii");
  buf[offset + length - 1] = 0;
}

/**
 * Create a 512-byte tar header for a file entry.
 */
function createHeader(name: string, size: number, mtime: number): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE, 0);

  // Name (bytes 0-99)
  header.write(name, 0, Math.min(name.length, 100), "utf8");

  // File mode (bytes 100-107): 0644
  writeOctal(header, 0o644, 100, 8);

  // Owner UID (bytes 108-115)
  writeOctal(header, 1000, 108, 8);

  // Group GID (bytes 116-123)
  writeOctal(header, 1000, 116, 8);

  // File size (bytes 124-135)
  writeOctal(header, size, 124, 12);

  // Modification time (bytes 136-147)
  writeOctal(header, mtime, 136, 12);

  // Type flag (byte 156): '0' for regular file
  header[156] = 0x30; // ASCII '0'

  // USTAR indicator (bytes 257-262)
  header.write("ustar", 257, 5, "ascii");
  header[262] = 0; // null terminator

  // USTAR version (bytes 263-264)
  header.write("00", 263, 2, "ascii");

  // Owner name (bytes 265-296)
  header.write("root", 265, 4, "ascii");

  // Group name (bytes 297-328)
  header.write("root", 297, 4, "ascii");

  // Compute and write checksum (bytes 148-155)
  const checksum = computeChecksum(header);
  // Checksum is written as 6 octal digits + null + space
  const checksumStr = checksum.toString(8).padStart(6, "0");
  header.write(checksumStr, 148, 6, "ascii");
  header[154] = 0;   // null
  header[155] = 0x20; // space

  return header;
}

/**
 * Create a tar archive from an array of entries.
 * Returns a Buffer containing the raw tar data (not gzipped).
 */
export function createTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  const mtime = Math.floor(Date.now() / 1000);

  for (const entry of entries) {
    const header = createHeader(entry.name, entry.content.length, mtime);
    parts.push(header);

    // Write file content
    parts.push(entry.content);

    // Pad to 512-byte boundary
    const remainder = entry.content.length % BLOCK_SIZE;
    if (remainder > 0) {
      parts.push(Buffer.alloc(BLOCK_SIZE - remainder, 0));
    }
  }

  // End-of-archive marker: two 512-byte blocks of zeros
  parts.push(Buffer.alloc(BLOCK_SIZE * 2, 0));

  return Buffer.concat(parts);
}

/**
 * Read a null-terminated string from a buffer region.
 */
function readString(buf: Buffer, offset: number, length: number): string {
  let end = offset;
  const max = offset + length;
  while (end < max && buf[end] !== 0) {
    end++;
  }
  return buf.subarray(offset, end).toString("utf8");
}

/**
 * Read an octal number from a null-terminated buffer region.
 */
function readOctal(buf: Buffer, offset: number, length: number): number {
  const str = readString(buf, offset, length).trim();
  if (str.length === 0) return 0;
  return parseInt(str, 8);
}

/**
 * Extract entries from a tar archive buffer.
 * Returns an array of { name, content } entries.
 */
export function extractTar(tarBuffer: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + BLOCK_SIZE <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + BLOCK_SIZE);

    // Check for end-of-archive (all zeros)
    let allZero = true;
    for (let i = 0; i < BLOCK_SIZE; i++) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const name = readString(header, 0, 100);
    const size = readOctal(header, 124, 12);
    const typeFlag = header[156];

    offset += BLOCK_SIZE;

    // Only process regular files (type '0' or '\0')
    if (typeFlag === 0x30 || typeFlag === 0) {
      if (offset + size <= tarBuffer.length) {
        const content = Buffer.from(tarBuffer.subarray(offset, offset + size));
        entries.push({ name, content });
      }
    }

    // Advance past content (padded to 512 boundary)
    const blocks = Math.ceil(size / BLOCK_SIZE);
    offset += blocks * BLOCK_SIZE;
  }

  return entries;
}
