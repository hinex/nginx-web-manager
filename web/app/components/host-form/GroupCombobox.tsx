import { useState, useRef, useEffect } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { X, ChevronDown, Plus } from "lucide-react";

interface GroupComboboxProps {
  groups: Array<{ id: number; name: string }>;
  value: number | null;
  onChange: (groupId: number | null) => void;
  onCreateGroup?: (name: string) => void;
}

export function GroupCombobox({ groups, value, onChange, onCreateGroup }: GroupComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedGroup = groups.find((g) => g.id === value);
  const filtered = groups.filter((g) =>
    g.name.toLowerCase().includes(search.toLowerCase())
  );
  const exactMatch = groups.some(
    (g) => g.name.toLowerCase() === search.trim().toLowerCase()
  );
  const showCreate = onCreateGroup && search.trim() && !exactMatch;

  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger */}
      <div
        className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={() => setOpen(!open)}
      >
        <span className={selectedGroup ? "" : "text-muted-foreground"}>
          {selectedGroup?.name ?? "Ungrouped"}
        </span>
        <div className="flex items-center gap-1">
          {value !== null && (
            <button
              type="button"
              className="rounded-sm p-0.5 hover:bg-muted"
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
              }}
            >
              <X className="h-3 w-3" />
            </button>
          )}
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
          <div className="p-2">
            <Input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={onCreateGroup ? "Search or create group..." : "Search groups..."}
              className="h-8 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setOpen(false);
                }
              }}
            />
          </div>
          <div className="max-h-48 overflow-y-auto px-1 pb-1">
            {/* Ungrouped option */}
            <button
              type="button"
              className={`flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent cursor-pointer ${
                value === null ? "bg-accent" : ""
              }`}
              onClick={() => {
                onChange(null);
                setOpen(false);
                setSearch("");
              }}
            >
              <span className="text-muted-foreground italic">Ungrouped</span>
            </button>

            {filtered.length > 0 && (
              <div className="my-1 border-t border-border" />
            )}

            {filtered.map((group) => (
              <button
                key={group.id}
                type="button"
                className={`flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent cursor-pointer ${
                  value === group.id ? "bg-accent" : ""
                }`}
                onClick={() => {
                  onChange(group.id);
                  setOpen(false);
                  setSearch("");
                }}
              >
                {group.name}
              </button>
            ))}

            {filtered.length === 0 && !showCreate && (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">
                No groups found.{onCreateGroup ? " Type a name to create one." : ""}
              </div>
            )}

            {/* Create option — shown when typing a new name */}
            {showCreate && (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent cursor-pointer text-primary font-medium"
                onClick={() => {
                  onCreateGroup(search.trim());
                  setSearch("");
                  setOpen(false);
                }}
              >
                <Plus className="h-3 w-3" />
                Create &quot;{search.trim()}&quot;
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
