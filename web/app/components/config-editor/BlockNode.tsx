import { useState } from "react";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import type { NgxDirective } from "~/lib/nginx/parser";
import { cn } from "~/lib/utils";

interface BlockNodeProps {
  directive: NgxDirective;
  depth: number;
  onUpdate: (updated: NgxDirective) => void;
  onDelete: () => void;
}

export function BlockNode({ directive, depth, onUpdate, onDelete }: BlockNodeProps) {
  const [collapsed, setCollapsed] = useState(false);
  const hasBlock = !!directive.block;

  const handleArgChange = (index: number, newValue: string) => {
    const newArgs = [...directive.args];
    newArgs[index] = newValue;
    onUpdate({ ...directive, args: newArgs });
  };

  const handleDirectiveUpdate = (childIndex: number, updated: NgxDirective) => {
    if (!directive.block) return;
    const newDirectives = [...directive.block.directives];
    newDirectives[childIndex] = updated;
    onUpdate({ ...directive, block: { directives: newDirectives } });
  };

  const handleDirectiveDelete = (childIndex: number) => {
    if (!directive.block) return;
    const newDirectives = directive.block.directives.filter((_, i) => i !== childIndex);
    onUpdate({ ...directive, block: { directives: newDirectives } });
  };

  const handleAddDirective = () => {
    if (!directive.block) return;
    const newDirective: NgxDirective = {
      name: "new_directive",
      args: ["value"],
      line: 0,
    };
    onUpdate({
      ...directive,
      block: { directives: [...directive.block.directives, newDirective] },
    });
  };

  if (!hasBlock) {
    // Simple directive — inline editable row
    return (
      <div className="group flex items-center gap-2 px-3 py-1.5 hover:bg-muted/50 rounded text-sm">
        <span className="font-medium text-primary shrink-0">{directive.name}</span>
        {directive.args.map((arg, i) => (
          <input
            key={i}
            type="text"
            value={arg}
            onChange={(e) => handleArgChange(i, e.target.value)}
            className="bg-transparent border-b border-transparent hover:border-border focus:border-primary outline-none px-1 text-foreground min-w-[3ch]"
            style={{ width: `${Math.max(arg.length + 1, 3)}ch` }}
          />
        ))}
        <button
          onClick={onDelete}
          className="ml-auto opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
          title="Delete directive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  // Block directive — collapsible card
  return (
    <div className={cn(
      "border rounded-lg my-1",
      depth === 0 ? "border-border" : "border-border/50"
    )}>
      <div
        className="group flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-muted/50 rounded-t-lg select-none"
        onClick={() => setCollapsed(!collapsed)}
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
        <span className="font-semibold text-sm text-primary">{directive.name}</span>
        {directive.args.map((arg, i) => (
          <span key={i} className="text-sm text-muted-foreground">{arg}</span>
        ))}
        <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => { e.stopPropagation(); handleAddDirective(); }}
            className="text-muted-foreground hover:text-primary p-0.5"
            title="Add directive"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="text-muted-foreground hover:text-destructive p-0.5"
            title="Delete block"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {!collapsed && directive.block && (
        <div className="pl-4 pb-2 border-t border-border/30">
          {directive.block.directives.map((child, i) => (
            <BlockNode
              key={`${child.name}-${child.line}-${i}`}
              directive={child}
              depth={depth + 1}
              onUpdate={(updated) => handleDirectiveUpdate(i, updated)}
              onDelete={() => handleDirectiveDelete(i)}
            />
          ))}
          <button
            onClick={handleAddDirective}
            className="flex items-center gap-1 px-3 py-1 text-xs text-muted-foreground hover:text-primary transition-colors"
          >
            <Plus className="h-3 w-3" /> Add directive
          </button>
        </div>
      )}
    </div>
  );
}
