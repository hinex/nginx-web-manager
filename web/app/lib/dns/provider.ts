export interface DnsRecord {
  id: string;
  type: string; // A, AAAA, CNAME, MX, TXT, etc.
  name: string; // e.g., "example.com" or "sub.example.com"
  content: string; // e.g., "1.2.3.4" or "mail.example.com"
  ttl: number; // TTL in seconds (1 = auto for Cloudflare)
  proxied?: boolean; // Cloudflare-specific: orange cloud
  priority?: number; // for MX records
}

export interface DnsZone {
  id: string;
  name: string; // e.g., "example.com"
  status: string;
}

export interface DnsProvider {
  listZones(): Promise<DnsZone[]>;
  listRecords(zoneId: string): Promise<DnsRecord[]>;
  createRecord(
    zoneId: string,
    record: Omit<DnsRecord, "id">
  ): Promise<DnsRecord>;
  updateRecord(
    zoneId: string,
    recordId: string,
    record: Partial<Omit<DnsRecord, "id">>
  ): Promise<DnsRecord>;
  deleteRecord(zoneId: string, recordId: string): Promise<void>;
}
