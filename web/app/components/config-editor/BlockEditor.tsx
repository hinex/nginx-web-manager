import { useState, useCallback } from "react";
import type { NgxDirective } from "~/lib/nginx/parser";
import { parse } from "~/lib/nginx/parser/ast";
import { render } from "~/lib/nginx/parser/renderer";
import { BlockNode } from "./BlockNode";
import { Plus } from "lucide-react";

interface BlockEditorProps {
  value: string;
  onChange?: (value: string) => void;
}

export function BlockEditor({ value, onChange }: BlockEditorProps) {
  const [config, setConfig] = useState(() => parse(value));

  const updateAndEmit = useCallback(
    (newDirectives: NgxDirective[]) => {
      const newConfig = { ...config, directives: newDirectives };
      setConfig(newConfig);
      onChange?.(render(newConfig));
    },
    [config, onChange]
  );

  const handleUpdate = useCallback(
    (index: number, updated: NgxDirective) => {
      const newDirectives = [...config.directives];
      newDirectives[index] = updated;
      updateAndEmit(newDirectives);
    },
    [config.directives, updateAndEmit]
  );

  const handleDelete = useCallback(
    (index: number) => {
      updateAndEmit(config.directives.filter((_, i) => i !== index));
    },
    [config.directives, updateAndEmit]
  );

  const handleAdd = useCallback(() => {
    const newDirective: NgxDirective = {
      name: "server",
      args: [],
      block: { directives: [{ name: "listen", args: ["80"], line: 0 }] },
      line: 0,
    };
    updateAndEmit([...config.directives, newDirective]);
  }, [config.directives, updateAndEmit]);

  return (
    <div className="space-y-1 p-4">
      {config.directives.map((directive, i) => (
        <BlockNode
          key={`${directive.name}-${directive.line}-${i}`}
          directive={directive}
          depth={0}
          onUpdate={(updated) => handleUpdate(i, updated)}
          onDelete={() => handleDelete(i)}
        />
      ))}
      <button
        onClick={handleAdd}
        className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-primary border border-dashed border-border rounded-lg w-full justify-center mt-4 transition-colors"
      >
        <Plus className="h-4 w-4" /> Add block
      </button>
    </div>
  );
}
