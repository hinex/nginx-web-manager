import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { Plus, Trash2, Eye, EyeOff } from "lucide-react";
import { useState } from "react";

interface BasicAuthData {
  enabled: boolean;
  users: Array<{ username: string; password: string }>;
}

interface AuthTabProps {
  basicAuth: BasicAuthData | null;
  setBasicAuth: (auth: BasicAuthData | null) => void;
}

export function AuthTab({ basicAuth, setBasicAuth }: AuthTabProps) {
  const enabled = basicAuth?.enabled ?? false;
  const users = basicAuth?.users ?? [];
  const [showPasswords, setShowPasswords] = useState<Record<number, boolean>>({});

  const toggleEnabled = (checked: boolean) => {
    if (checked) {
      setBasicAuth({ enabled: true, users: users.length > 0 ? users : [{ username: "", password: "" }] });
    } else {
      setBasicAuth(null);
    }
  };

  const addUser = () => {
    setBasicAuth({ enabled: true, users: [...users, { username: "", password: "" }] });
  };

  const removeUser = (index: number) => {
    const updated = users.filter((_, i) => i !== index);
    if (updated.length === 0) {
      setBasicAuth(null);
    } else {
      setBasicAuth({ enabled: true, users: updated });
    }
  };

  const updateUser = (index: number, field: "username" | "password", value: string) => {
    const updated = [...users];
    updated[index] = { ...updated[index], [field]: value };
    setBasicAuth({ enabled: true, users: updated });
  };

  const togglePasswordVisibility = (index: number) => {
    setShowPasswords((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Switch checked={enabled} onCheckedChange={toggleEnabled} />
        <Label>Enable HTTP Basic Auth</Label>
      </div>

      {enabled && (
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <Label className="text-xs">Users</Label>
            <Button variant="outline" size="sm" type="button" onClick={addUser}>
              <Plus className="mr-2 h-3 w-3" />
              Add User
            </Button>
          </div>

          {users.map((user, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                type="text"
                value={user.username}
                onChange={(e) => updateUser(index, "username", e.target.value)}
                placeholder="Username"
                className="flex-1"
              />
              <div className="relative flex-1">
                <Input
                  type={showPasswords[index] ? "text" : "password"}
                  value={user.password}
                  onChange={(e) => updateUser(index, "password", e.target.value)}
                  placeholder="Password"
                  className="pr-9"
                />
                <button
                  type="button"
                  onClick={() => togglePasswordVisibility(index)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPasswords[index] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Button variant="ghost" size="sm" type="button" onClick={() => removeUser(index)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}

          {users.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No users configured. Add at least one user to enable auth.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
