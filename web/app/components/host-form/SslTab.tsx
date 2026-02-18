import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { Separator } from "~/components/ui/separator";
import { cn } from "~/lib/utils";

interface SslTabProps {
  sslType: string;
  setSslType: (type: string) => void;
  sslCertPath: string;
  setSslCertPath: (path: string) => void;
  sslKeyPath: string;
  setSslKeyPath: (path: string) => void;
  sslForceHttps: boolean;
  setSslForceHttps: (force: boolean) => void;
  http2: boolean;
  setHttp2: (http2: boolean) => void;
  hsts: boolean;
  setHsts: (hsts: boolean) => void;
  redirectWww: boolean;
  setRedirectWww: (redirectWww: boolean) => void;
}

const sslOptions = [
  { value: "none", label: "None" },
  { value: "letsencrypt", label: "Let's Encrypt (automatic)" },
  { value: "custom", label: "Custom Certificate" },
];

export function SslTab({
  sslType,
  setSslType,
  sslCertPath,
  setSslCertPath,
  sslKeyPath,
  setSslKeyPath,
  sslForceHttps,
  setSslForceHttps,
  http2,
  setHttp2,
  hsts,
  setHsts,
  redirectWww,
  setRedirectWww,
}: SslTabProps) {
  return (
    <div className="space-y-4">
      <div>
        <Label className="mb-2">SSL Type</Label>
        <div className="space-y-2">
          {sslOptions.map((option) => (
            <label
              key={option.value}
              className={cn(
                "flex items-center gap-3 rounded-md border border-input p-3 cursor-pointer transition-colors",
                sslType === option.value && "border-primary bg-primary/5"
              )}
            >
              <input
                type="radio"
                value={option.value}
                checked={sslType === option.value}
                onChange={(e) => setSslType(e.target.value)}
                className="sr-only"
              />
              <div
                className={cn(
                  "h-4 w-4 rounded-full border-2",
                  sslType === option.value
                    ? "border-primary bg-primary"
                    : "border-muted-foreground"
                )}
              >
                {sslType === option.value && (
                  <div className="h-full w-full rounded-full border-2 border-background" />
                )}
              </div>
              <span className="text-sm">{option.label}</span>
            </label>
          ))}
        </div>
      </div>

      {sslType === "custom" && (
        <div className="ml-4 border-l-2 border-primary/30 pl-4 space-y-3">
          <div>
            <Label className="mb-1">Certificate Path</Label>
            <Input
              type="text"
              value={sslCertPath}
              onChange={(e) => setSslCertPath(e.target.value)}
              placeholder="/etc/ssl/certs/example.com.crt"
            />
          </div>
          <div>
            <Label className="mb-1">Private Key Path</Label>
            <Input
              type="text"
              value={sslKeyPath}
              onChange={(e) => setSslKeyPath(e.target.value)}
              placeholder="/etc/ssl/private/example.com.key"
            />
          </div>
        </div>
      )}

      <Separator />

      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Switch checked={sslForceHttps} onCheckedChange={setSslForceHttps} />
          <Label>Force HTTPS (redirect HTTP to HTTPS)</Label>
        </div>

        <div className="flex items-center gap-3">
          <Switch checked={http2} onCheckedChange={setHttp2} />
          <Label>Enable HTTP/2</Label>
        </div>

        <div className="flex items-center gap-3">
          <Switch checked={hsts} onCheckedChange={setHsts} />
          <Label>Enable HSTS (HTTP Strict Transport Security)</Label>
        </div>

        <div className="flex items-center gap-3">
          <Switch checked={redirectWww} onCheckedChange={setRedirectWww} />
          <Label>Redirect from www (301 www.domain → domain)</Label>
        </div>
      </div>
    </div>
  );
}
