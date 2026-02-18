import { useFetcher } from "react-router";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "~/components/ui/dialog";
import { Plus, Pencil, Trash2 } from "lucide-react";

export interface GroupItem {
  id: number;
  name: string;
  description: string | null;
  webhookUrl: string | null;
  hostCount: number;
}

interface GroupsModalProps {
  open: boolean;
  onClose: () => void;
  groups: GroupItem[];
  actionUrl: string;
}

export function GroupsModal({ open, onClose, groups, actionUrl }: GroupsModalProps) {
  const fetcher = useFetcher();
  const [editingGroup, setEditingGroup] = useState<GroupItem | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");

  const resetForm = () => {
    setEditingGroup(null);
    setShowForm(false);
    setName("");
    setDescription("");
    setWebhookUrl("");
  };

  const startEdit = (group: GroupItem) => {
    setEditingGroup(group);
    setShowForm(true);
    setName(group.name);
    setDescription(group.description ?? "");
    setWebhookUrl(group.webhookUrl ?? "");
  };

  const startCreate = () => {
    resetForm();
    setShowForm(true);
  };

  const handleSave = () => {
    if (!name.trim()) {
      toast.error("Group name is required");
      return;
    }
    if (webhookUrl && !/^https?:\/\/.+/.test(webhookUrl)) {
      toast.error("Webhook URL must be a valid HTTP/HTTPS URL");
      return;
    }
    fetcher.submit(
      {
        intent: editingGroup ? "updateGroup" : "createGroup",
        ...(editingGroup ? { id: String(editingGroup.id) } : {}),
        name: name.trim(),
        description,
        webhookUrl,
      },
      { method: "post", action: actionUrl }
    );
    resetForm();
  };

  const handleDelete = (id: number) => {
    fetcher.submit(
      { intent: "deleteGroup", id: String(id) },
      { method: "post", action: actionUrl }
    );
  };

  useEffect(() => {
    if (fetcher.data?.error) {
      toast.error(fetcher.data.error);
    }
  }, [fetcher.data]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Manage Groups</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            {groups.map((group) => (
              <div key={group.id} className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <p className="font-medium text-sm">{group.name}</p>
                  {group.description && (
                    <p className="text-xs text-muted-foreground">{group.description}</p>
                  )}
                  <p className="text-xs text-muted-foreground">{group.hostCount} hosts</p>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEdit(group)}>
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleDelete(group.id)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
            {groups.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-2">No groups yet</p>
            )}
          </div>

          {showForm ? (
            <div className="border-t pt-4 space-y-3">
              <div>
                <Label className="text-xs mb-1">Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Group name" />
              </div>
              <div>
                <Label className="text-xs mb-1">Description</Label>
                <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
              </div>
              <div>
                <Label className="text-xs mb-1">Webhook URL</Label>
                <Input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://..." />
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSave}>
                  {editingGroup ? "Update" : "Create"} Group
                </Button>
                <Button size="sm" variant="outline" onClick={resetForm}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" size="sm" className="w-full" onClick={startCreate}>
              <Plus className="mr-2 h-4 w-4" />
              Add Group
            </Button>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
