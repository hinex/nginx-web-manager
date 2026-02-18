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
import { Pencil, Trash2 } from "lucide-react";
import { cn } from "~/lib/utils";

const LABEL_COLORS = [
  { value: "green", bg: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" },
  { value: "yellow", bg: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200" },
  { value: "blue", bg: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" },
  { value: "red", bg: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200" },
  { value: "purple", bg: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200" },
  { value: "orange", bg: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200" },
  { value: "pink", bg: "bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200" },
  { value: "gray", bg: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200" },
];

export { LABEL_COLORS };

export interface LabelItem {
  id: number;
  name: string;
  color: string;
}

interface LabelsModalProps {
  open: boolean;
  onClose: () => void;
  labels: LabelItem[];
  actionUrl: string;
}

export function LabelsModal({ open, onClose, labels, actionUrl }: LabelsModalProps) {
  const fetcher = useFetcher();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState("green");

  const resetForm = () => {
    setEditingId(null);
    setName("");
    setColor("green");
  };

  const startEdit = (label: LabelItem) => {
    setEditingId(label.id);
    setName(label.name);
    setColor(label.color);
  };

  const handleSave = () => {
    if (!name.trim()) {
      toast.error("Label name is required");
      return;
    }
    fetcher.submit(
      {
        intent: editingId ? "updateLabel" : "createLabel",
        ...(editingId ? { id: String(editingId) } : {}),
        name: name.trim(),
        color,
      },
      { method: "post", action: actionUrl }
    );
    resetForm();
  };

  const handleDelete = (id: number) => {
    fetcher.submit(
      { intent: "deleteLabel", id: String(id) },
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manage Labels</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            {labels.map((label) => (
              <div key={label.id} className="flex items-center gap-2">
                <span
                  className={cn(
                    "px-2 py-1 rounded text-xs font-medium flex-1",
                    LABEL_COLORS.find((c) => c.value === label.color)?.bg
                  )}
                >
                  {label.name}
                </span>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEdit(label)}>
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleDelete(label.id)}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
            {labels.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-2">No labels yet</p>
            )}
          </div>

          <div className="border-t pt-4 space-y-3">
            <div>
              <Label className="text-xs mb-1">Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Backend"
              />
            </div>
            <div>
              <Label className="text-xs mb-1">Color</Label>
              <div className="flex gap-2 flex-wrap">
                {LABEL_COLORS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => setColor(c.value)}
                    className={cn(
                      "px-3 py-1 rounded text-xs font-medium border-2 transition-colors",
                      c.bg,
                      color === c.value ? "border-foreground" : "border-transparent"
                    )}
                  >
                    {c.value}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave}>
                {editingId ? "Update" : "Add"} Label
              </Button>
              {editingId && (
                <Button size="sm" variant="outline" onClick={resetForm}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function getLabelColorClass(color: string): string {
  return LABEL_COLORS.find((c) => c.value === color)?.bg ?? LABEL_COLORS[7].bg;
}
