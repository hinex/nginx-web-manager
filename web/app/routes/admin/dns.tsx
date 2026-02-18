import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Checkbox } from "~/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type { DnsRecord, DnsZone } from "~/lib/dns/provider";
import { PageHeader } from "~/components/PageHeader";

export function meta() {
  return [{ title: "DNS Management — Nginx Manager" }];
}

interface Credential {
  id: number;
  name: string;
  provider: string;
  createdAt: string;
}

async function dnsApi(body: Record<string, unknown>) {
  const res = await fetch("/api/dns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "API error");
  return data;
}

// ─── Record Types ───────────────────────────────────────
const RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT"];

const recordTypeBadgeColor: Record<string, string> = {
  A: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  AAAA: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200",
  CNAME:
    "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  MX: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  TXT: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
};

function formatTtl(ttl: number): string {
  if (ttl === 1) return "Auto";
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.floor(ttl / 60)}m`;
  if (ttl < 86400) return `${Math.floor(ttl / 3600)}h`;
  return `${Math.floor(ttl / 86400)}d`;
}

// ─── Main Page ──────────────────────────────────────────
export default function DnsPage() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loadingCreds, setLoadingCreds] = useState(true);

  // Credential dialog
  const [showCredDialog, setShowCredDialog] = useState(false);
  const [credName, setCredName] = useState("");
  const [credProvider, setCredProvider] = useState("cloudflare");
  const [credApiToken, setCredApiToken] = useState("");
  const [savingCred, setSavingCred] = useState(false);

  // Delete credential confirm
  const [deleteCredId, setDeleteCredId] = useState<number | null>(null);

  // DNS Records section
  const [selectedCredId, setSelectedCredId] = useState<string>("");
  const [zones, setZones] = useState<DnsZone[]>([]);
  const [loadingZones, setLoadingZones] = useState(false);
  const [selectedZoneId, setSelectedZoneId] = useState<string>("");
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(false);

  // Record dialog
  const [showRecordDialog, setShowRecordDialog] = useState(false);
  const [editingRecord, setEditingRecord] = useState<DnsRecord | null>(null);
  const [recordType, setRecordType] = useState("A");
  const [recordName, setRecordName] = useState("");
  const [recordContent, setRecordContent] = useState("");
  const [recordTtl, setRecordTtl] = useState("1");
  const [recordProxied, setRecordProxied] = useState(false);
  const [recordPriority, setRecordPriority] = useState("10");
  const [savingRecord, setSavingRecord] = useState(false);

  // Delete record confirm
  const [deleteRecordId, setDeleteRecordId] = useState<string | null>(null);

  // ─── Load credentials ─────────────────────────────────
  const loadCredentials = useCallback(async () => {
    setLoadingCreds(true);
    try {
      const data = await dnsApi({ action: "list-credentials" });
      setCredentials(data.credentials);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoadingCreds(false);
    }
  }, []);

  useEffect(() => {
    loadCredentials();
  }, [loadCredentials]);

  // ─── Load zones when credential changes ───────────────
  useEffect(() => {
    if (!selectedCredId) {
      setZones([]);
      setSelectedZoneId("");
      setRecords([]);
      return;
    }
    setLoadingZones(true);
    setSelectedZoneId("");
    setRecords([]);
    dnsApi({ action: "list-zones", credentialId: Number(selectedCredId) })
      .then((data) => setZones(data.zones))
      .catch((err: any) => toast.error(err.message))
      .finally(() => setLoadingZones(false));
  }, [selectedCredId]);

  // ─── Load records when zone changes ───────────────────
  const loadRecords = useCallback(async () => {
    if (!selectedCredId || !selectedZoneId) {
      setRecords([]);
      return;
    }
    setLoadingRecords(true);
    try {
      const data = await dnsApi({
        action: "list-records",
        credentialId: Number(selectedCredId),
        zoneId: selectedZoneId,
      });
      setRecords(data.records);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoadingRecords(false);
    }
  }, [selectedCredId, selectedZoneId]);

  useEffect(() => {
    loadRecords();
  }, [loadRecords]);

  // ─── Credential actions ───────────────────────────────
  const handleAddCredential = async () => {
    if (!credName.trim() || !credApiToken.trim()) {
      toast.error("Name and API token are required");
      return;
    }
    setSavingCred(true);
    try {
      await dnsApi({
        action: "add-credential",
        name: credName.trim(),
        provider: credProvider,
        apiToken: credApiToken.trim(),
      });
      toast.success("Credential added");
      setShowCredDialog(false);
      setCredName("");
      setCredApiToken("");
      loadCredentials();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSavingCred(false);
    }
  };

  const handleDeleteCredential = async () => {
    if (!deleteCredId) return;
    try {
      await dnsApi({ action: "delete-credential", id: deleteCredId });
      toast.success("Credential deleted");
      if (selectedCredId === String(deleteCredId)) {
        setSelectedCredId("");
      }
      loadCredentials();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setDeleteCredId(null);
    }
  };

  // ─── Record actions ───────────────────────────────────
  const openCreateRecord = () => {
    setEditingRecord(null);
    setRecordType("A");
    setRecordName("");
    setRecordContent("");
    setRecordTtl("1");
    setRecordProxied(false);
    setRecordPriority("10");
    setShowRecordDialog(true);
  };

  const openEditRecord = (record: DnsRecord) => {
    setEditingRecord(record);
    setRecordType(record.type);
    setRecordName(record.name);
    setRecordContent(record.content);
    setRecordTtl(String(record.ttl));
    setRecordProxied(record.proxied ?? false);
    setRecordPriority(String(record.priority ?? 10));
    setShowRecordDialog(true);
  };

  const handleSaveRecord = async () => {
    if (!recordName.trim() || !recordContent.trim()) {
      toast.error("Name and content are required");
      return;
    }
    setSavingRecord(true);
    try {
      const recordData: Record<string, unknown> = {
        type: recordType,
        name: recordName.trim(),
        content: recordContent.trim(),
        ttl: Number(recordTtl) || 1,
        proxied: recordProxied,
      };
      if (recordType === "MX") {
        recordData.priority = Number(recordPriority) || 10;
      }

      if (editingRecord) {
        await dnsApi({
          action: "update-record",
          credentialId: Number(selectedCredId),
          zoneId: selectedZoneId,
          recordId: editingRecord.id,
          record: recordData,
        });
        toast.success("Record updated");
      } else {
        await dnsApi({
          action: "create-record",
          credentialId: Number(selectedCredId),
          zoneId: selectedZoneId,
          record: recordData,
        });
        toast.success("Record created");
      }
      setShowRecordDialog(false);
      loadRecords();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSavingRecord(false);
    }
  };

  const handleDeleteRecord = async () => {
    if (!deleteRecordId) return;
    try {
      await dnsApi({
        action: "delete-record",
        credentialId: Number(selectedCredId),
        zoneId: selectedZoneId,
        recordId: deleteRecordId,
      });
      toast.success("Record deleted");
      loadRecords();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setDeleteRecordId(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="DNS Management"
        description="Manage DNS zones and records"
      />

      {/* ─── Credentials Section ─────────────────────────── */}
      <Card glass>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle className="text-lg">DNS Credentials</CardTitle>
          <Button size="sm" onClick={() => setShowCredDialog(true)} className="press-effect">
            <Plus className="mr-2 h-4 w-4" />
            Add Credential
          </Button>
        </CardHeader>
        <CardContent>
          {loadingCreds ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : credentials.length === 0 ? (
            <div className="rounded-md border p-6 text-center text-muted-foreground">
              No DNS credentials configured. Add one to get started.
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="w-[70px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {credentials.map((cred) => (
                    <TableRow key={cred.id} className="hover:bg-muted/30 transition-colors">
                      <TableCell className="font-medium">{cred.name}</TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="capitalize">
                          {cred.provider}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(cred.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                          onClick={() => setDeleteCredId(cred.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── DNS Records Section ─────────────────────────── */}
      <Card glass>
        <CardHeader>
          <CardTitle className="text-lg">DNS Records</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Selectors */}
          <div className="flex gap-4 items-end flex-wrap">
            <div className="space-y-2 min-w-[200px] flex-1">
              <Label>Credential</Label>
              <Select
                value={selectedCredId}
                onValueChange={setSelectedCredId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a credential" />
                </SelectTrigger>
                <SelectContent>
                  {credentials.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2 min-w-[200px] flex-1">
              <Label>Zone</Label>
              <Select
                value={selectedZoneId}
                onValueChange={setSelectedZoneId}
                disabled={!selectedCredId || loadingZones}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      loadingZones ? "Loading zones..." : "Select a zone"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {zones.map((z) => (
                    <SelectItem key={z.id} value={z.id}>
                      {z.name}{" "}
                      <span className="text-muted-foreground">
                        ({z.status})
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedZoneId && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadRecords}
                  disabled={loadingRecords}
                >
                  <RefreshCw
                    className={`mr-2 h-4 w-4 ${loadingRecords ? "animate-spin" : ""}`}
                  />
                  Refresh
                </Button>
                <Button size="sm" onClick={openCreateRecord} className="press-effect">
                  <Plus className="mr-2 h-4 w-4" />
                  Add Record
                </Button>
              </div>
            )}
          </div>

          {/* Records Table */}
          {!selectedCredId || !selectedZoneId ? (
            <div className="rounded-md border p-6 text-center text-muted-foreground">
              Select a credential and zone to view DNS records.
            </div>
          ) : loadingRecords ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : records.length === 0 ? (
            <div className="rounded-md border p-6 text-center text-muted-foreground">
              No DNS records found for this zone.
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[80px]">Type</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Content</TableHead>
                    <TableHead className="w-[80px]">TTL</TableHead>
                    <TableHead className="w-[80px]">Proxied</TableHead>
                    <TableHead className="w-[70px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records.map((record) => (
                    <TableRow key={record.id} className="hover:bg-muted/30 transition-colors">
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={
                            recordTypeBadgeColor[record.type] || undefined
                          }
                        >
                          {record.type}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {record.name}
                      </TableCell>
                      <TableCell className="font-mono text-sm max-w-[300px] truncate">
                        {record.type === "MX" && record.priority != null
                          ? `${record.priority} ${record.content}`
                          : record.content}
                      </TableCell>
                      <TableCell>{formatTtl(record.ttl)}</TableCell>
                      <TableCell>
                        {record.proxied != null && (
                          <Badge
                            variant={record.proxied ? "default" : "outline"}
                            className={
                              record.proxied
                                ? "bg-orange-500 hover:bg-orange-500 text-white"
                                : ""
                            }
                          >
                            {record.proxied ? "On" : "Off"}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0"
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => openEditRecord(record)}
                            >
                              <Pencil className="mr-2 h-4 w-4" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setDeleteRecordId(record.id)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Add Credential Dialog ───────────────────────── */}
      <Dialog open={showCredDialog} onOpenChange={setShowCredDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add DNS Credential</DialogTitle>
            <DialogDescription>
              Add a DNS provider credential to manage your domains.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cred-name">Name</Label>
              <Input
                id="cred-name"
                placeholder="e.g., My Cloudflare Account"
                value={credName}
                onChange={(e) => setCredName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cred-provider">Provider</Label>
              <Select value={credProvider} onValueChange={setCredProvider}>
                <SelectTrigger id="cred-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cloudflare">Cloudflare</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cred-token">API Token</Label>
              <Input
                id="cred-token"
                type="password"
                placeholder="Enter your API token"
                value={credApiToken}
                onChange={(e) => setCredApiToken(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowCredDialog(false)}
              disabled={savingCred}
            >
              Cancel
            </Button>
            <Button onClick={handleAddCredential} disabled={savingCred}>
              {savingCred && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add Credential
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Delete Credential Confirm ───────────────────── */}
      <AlertDialog
        open={deleteCredId !== null}
        onOpenChange={(open) => !open && setDeleteCredId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Credential</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this DNS credential? This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteCredential}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ─── Record Dialog (Create/Edit) ─────────────────── */}
      <Dialog open={showRecordDialog} onOpenChange={setShowRecordDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingRecord ? "Edit DNS Record" : "Add DNS Record"}
            </DialogTitle>
            <DialogDescription>
              {editingRecord
                ? "Update the DNS record details below."
                : "Create a new DNS record for this zone."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="rec-type">Type</Label>
              <Select value={recordType} onValueChange={setRecordType}>
                <SelectTrigger id="rec-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECORD_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="rec-name">Name</Label>
              <Input
                id="rec-name"
                placeholder="e.g., example.com or sub.example.com"
                value={recordName}
                onChange={(e) => setRecordName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rec-content">Content</Label>
              <Input
                id="rec-content"
                placeholder={
                  recordType === "A"
                    ? "e.g., 1.2.3.4"
                    : recordType === "AAAA"
                      ? "e.g., 2001:db8::1"
                      : recordType === "CNAME"
                        ? "e.g., target.example.com"
                        : recordType === "MX"
                          ? "e.g., mail.example.com"
                          : "e.g., v=spf1 include:example.com ~all"
                }
                value={recordContent}
                onChange={(e) => setRecordContent(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="rec-ttl">TTL</Label>
                <Select value={recordTtl} onValueChange={setRecordTtl}>
                  <SelectTrigger id="rec-ttl">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">Auto</SelectItem>
                    <SelectItem value="60">1 minute</SelectItem>
                    <SelectItem value="300">5 minutes</SelectItem>
                    <SelectItem value="600">10 minutes</SelectItem>
                    <SelectItem value="1800">30 minutes</SelectItem>
                    <SelectItem value="3600">1 hour</SelectItem>
                    <SelectItem value="7200">2 hours</SelectItem>
                    <SelectItem value="18000">5 hours</SelectItem>
                    <SelectItem value="43200">12 hours</SelectItem>
                    <SelectItem value="86400">1 day</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {recordType === "MX" && (
                <div className="space-y-2">
                  <Label htmlFor="rec-priority">Priority</Label>
                  <Input
                    id="rec-priority"
                    type="number"
                    value={recordPriority}
                    onChange={(e) => setRecordPriority(e.target.value)}
                  />
                </div>
              )}
            </div>
            {(recordType === "A" || recordType === "AAAA" || recordType === "CNAME") && (
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="rec-proxied"
                  checked={recordProxied}
                  onCheckedChange={(checked) =>
                    setRecordProxied(checked === true)
                  }
                />
                <Label htmlFor="rec-proxied" className="font-normal">
                  Proxied through Cloudflare (orange cloud)
                </Label>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowRecordDialog(false)}
              disabled={savingRecord}
            >
              Cancel
            </Button>
            <Button onClick={handleSaveRecord} disabled={savingRecord}>
              {savingRecord && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {editingRecord ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Delete Record Confirm ───────────────────────── */}
      <AlertDialog
        open={deleteRecordId !== null}
        onOpenChange={(open) => !open && setDeleteRecordId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete DNS Record</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this DNS record? This action cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteRecord}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
