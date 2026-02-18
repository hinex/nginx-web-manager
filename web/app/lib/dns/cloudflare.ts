import type { DnsProvider, DnsRecord, DnsZone } from "./provider";

export class CloudflareDnsProvider implements DnsProvider {
  private apiToken: string;
  private baseUrl = "https://api.cloudflare.com/client/v4";

  constructor(apiToken: string) {
    this.apiToken = apiToken;
  }

  private async request(path: string, options: RequestInit = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    const data = await res.json();
    if (!data.success) {
      throw new Error(data.errors?.[0]?.message || "Cloudflare API error");
    }
    return data.result;
  }

  async listZones(): Promise<DnsZone[]> {
    const result = await this.request("/zones?per_page=50");
    return result.map((z: any) => ({
      id: z.id,
      name: z.name,
      status: z.status,
    }));
  }

  async listRecords(zoneId: string): Promise<DnsRecord[]> {
    const result = await this.request(
      `/zones/${zoneId}/dns_records?per_page=100`
    );
    return result.map((r: any) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      content: r.content,
      ttl: r.ttl,
      proxied: r.proxied,
      priority: r.priority,
    }));
  }

  async createRecord(
    zoneId: string,
    record: Omit<DnsRecord, "id">
  ): Promise<DnsRecord> {
    const result = await this.request(`/zones/${zoneId}/dns_records`, {
      method: "POST",
      body: JSON.stringify(record),
    });
    return {
      id: result.id,
      type: result.type,
      name: result.name,
      content: result.content,
      ttl: result.ttl,
      proxied: result.proxied,
      priority: result.priority,
    };
  }

  async updateRecord(
    zoneId: string,
    recordId: string,
    record: Partial<Omit<DnsRecord, "id">>
  ): Promise<DnsRecord> {
    const result = await this.request(
      `/zones/${zoneId}/dns_records/${recordId}`,
      {
        method: "PATCH",
        body: JSON.stringify(record),
      }
    );
    return {
      id: result.id,
      type: result.type,
      name: result.name,
      content: result.content,
      ttl: result.ttl,
      proxied: result.proxied,
      priority: result.priority,
    };
  }

  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    await this.request(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: "DELETE",
    });
  }
}
