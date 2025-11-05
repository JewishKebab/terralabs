import { useEffect, useMemo, useState } from "react";
import axios, { AxiosHeaders } from "axios";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Card } from "@/components/ui/card";
import { Database, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface BackendSelectionProps {
  onComplete: (backend: string) => void; // pass selected blob name or new backend name
}

type StateFile = {
  name: string;
  last_modified?: string | null;
  size?: number | null;
};

export function BackendSelection({ onComplete }: BackendSelectionProps) {
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [selectedBackend, setSelectedBackend] = useState("");
  const [newBackendName, setNewBackendName] = useState("");
  const [states, setStates] = useState<StateFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const { toast } = useToast();

  const api = useMemo(() => {
    const instance = axios.create({
      baseURL: "http://localhost:5000",
      headers: new AxiosHeaders({ "Content-Type": "application/json" }),
      timeout: 15000,
    });
    instance.interceptors.request.use((config) => {
      config.headers = AxiosHeaders.from(config.headers);
      const token = localStorage.getItem("auth_token");
      if (token) (config.headers as AxiosHeaders).set("Authorization", `Bearer ${token}`);
      return config;
    });
    return instance;
  }, []);

  useEffect(() => {
    const fetchStates = async () => {
      setLoading(true);
      setErr(null);
      try {
        const res = await api.get("/api/states");
        setStates(res.data?.states ?? []);
      } catch (e: any) {
        setErr(e?.response?.data?.error || e?.message || "Failed to load state files");
      } finally {
        setLoading(false);
      }
    };
    fetchStates();
  }, [api]);

  const handleSubmit = () => {
    const backend = mode === "new" ? newBackendName.trim() : selectedBackend;
    if (!backend) {
      toast({
        title: "Selection Required",
        description:
          mode === "new"
            ? "Enter a name for the new backend."
            : "Select a backend from Azure Storage.",
        variant: "destructive",
      });
      return;
    }
    onComplete(backend);
  };

  const formatDate = (iso?: string | null) => {
    if (!iso) return "n/a";
    try {
      const d = new Date(iso);
      return d.toISOString().slice(0, 10);
    } catch {
      return "n/a";
    }
  };

  return (
    <div className="space-y-6">
      <RadioGroup value={mode} onValueChange={(v) => setMode(v as "existing" | "new")}>
        <div className="flex items-center space-x-2">
          <RadioGroupItem value="existing" id="existing" />
          <Label htmlFor="existing" className="cursor-pointer">
            Use Existing Backend
          </Label>
        </div>
        <div className="flex items-center space-x-2">
          <RadioGroupItem value="new" id="new" />
          <Label htmlFor="new" className="cursor-pointer">
            Create New Backend
          </Label>
        </div>
      </RadioGroup>

      {mode === "existing" ? (
        <div className="space-y-3">
          <Label>Select Backend from Azure Storage</Label>

          {/* Loading */}
          {loading && (
            <div className="space-y-2">
              <Card className="p-4 animate-pulse" />
              <Card className="p-4 animate-pulse" />
              <Card className="p-4 animate-pulse" />
            </div>
          )}

          {/* Error */}
          {!loading && err && (
            <Card className="p-4 border-destructive/40">
              <p className="text-sm text-destructive">{err}</p>
            </Card>
          )}

          {/* Empty */}
          {!loading && !err && states.length === 0 && (
            <Card className="p-5">
              <p className="text-sm">
                No Terraform <code>.tfstate</code> files found in{" "}
                <code>bsmch-terralabs-labs-container</code>. When a lab writes a state file,
                it will appear here.
              </p>
            </Card>
          )}

          {/* List */}
          {!loading && !err && states.length > 0 && (
            <div className="space-y-2">
              {states.map((s) => {
                const label = s.name.replace(/\.tfstate$/i, "");
                const lmTxt = `Last modified: ${formatDate(s.last_modified)}`;
                const active = selectedBackend === s.name;
                return (
                  <Card
                    key={s.name}
                    className={`p-4 cursor-pointer transition-all hover:shadow-md ${
                      active ? "border-primary shadow-glow" : ""
                    }`}
                    onClick={() => setSelectedBackend(s.name)}
                  >
                    <div className="flex items-center gap-3">
                      <Database className="h-5 w-5 text-primary" />
                      <div className="flex-1">
                        <p className="font-medium">{label}</p>
                        <p className="text-xs text-muted-foreground">{lmTxt}</p>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <Label htmlFor="backend-name">New Backend Name</Label>
          <div className="flex gap-2">
            <Input
              id="backend-name"
              placeholder="my-new-backend"
              value={newBackendName}
              onChange={(e) => setNewBackendName(e.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={handleSubmit}
              title="Use this name"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            This will create a new .tfstate backend the first time you run Terraform with this
            name (and your backend config). You can also provision it explicitly if you prefer.
          </p>
        </div>
      )}

      <Button
        onClick={handleSubmit}
        className="w-full"
        disabled={
          mode === "existing" ? states.length > 0 && !selectedBackend : newBackendName.trim() === ""
        }
      >
        Continue to Module Selection
      </Button>
    </div>
  );
}
