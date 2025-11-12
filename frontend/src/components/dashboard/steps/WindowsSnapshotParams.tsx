import { useMemo, useState, useEffect } from "react";
import axios, { AxiosHeaders } from "axios";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus, Trash2, Search, RefreshCw, CheckCircle2 } from "lucide-react";

type Disk = {
  name: string;
  lun: number;
  caching: "ReadWrite" | "ReadOnly" | "None";
  disk_size_gb: number;
};

type SnapshotItem = {
  name: string;
  id: string;
  time_created?: string | null;
  sku?: string | null;
  provisioning_state?: string | null;
};

// ✅ Helper to remove `.tfstate` and any folder prefix
const cleanLabName = (name: string) => {
  const last = (name || "").split("/").pop() || name;
  return last.replace(/\.tfstate$/i, "");
};

// ✅ Format "now + defaultMinutes" to local "YYYY-MM-DDTHH:mm" for <input type="datetime-local">
const defaultLocalDateTime = (defaultMinutesAhead = 120) => {
  const d = new Date(Date.now() + defaultMinutesAhead * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
};

// ✅ Convert local datetime-local value to UTC ISO string (ends with Z)
const localToUtcIso = (local: string): string | null => {
  if (!local) return null;
  const d = new Date(local);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
};

const API_BASE = "http://localhost:5000";

// small helper for debouncing searches
function useDebouncedValue<T>(value: T, delay = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

export default function WindowsSnapshotParams({
  course,
  labName,
  onBack,
  onDone,
}: {
  course: string;
  labName: string; // includes .tfstate for backend paths
  onBack: () => void;
  onDone: (r: any) => void;
}) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);

  const cleanedLab = cleanLabName(labName);
  const [derivedVmName, setDerivedVmName] = useState(`Projects-${cleanedLab}-VM`);

  useEffect(() => {
    const formattedCourse = course.charAt(0).toUpperCase() + course.slice(1).toLowerCase();
    const labBase = cleanLabName(labName);
    const formattedLab = labBase.charAt(0).toUpperCase() + labBase.slice(1);
    setDerivedVmName(`Projects-${formattedCourse}-${formattedLab}-VM`);
  }, [course, labName]);

  // Form state
  const [vmCount, setVmCount] = useState<number>(1);
  const [vmSize, setVmSize] = useState("Standard_D2s_v5");

  // ⬇️ Snapshot picker state (name search ➜ choose one ➜ we keep its ID)
  const [snapQuery, setSnapQuery] = useState("");
  const debouncedQuery = useDebouncedValue(snapQuery, 300);
  const [snapLoading, setSnapLoading] = useState(false);
  const [snapshots, setSnapshots] = useState<SnapshotItem[]>([]);
  const [selectedSnapshot, setSelectedSnapshot] = useState<SnapshotItem | null>(null);

  // Optional extra disks
  const [disks, setDisks] = useState<Disk[]>([]);

  // New: expiry (default 2 hours from now)
  const [expiresLocal, setExpiresLocal] = useState<string>(defaultLocalDateTime(120));

  const api = useMemo(() => {
    const i = axios.create({
      baseURL: API_BASE,
      headers: new AxiosHeaders({ "Content-Type": "application/json" }),
      timeout: 0, // allow long calls
    });
    i.interceptors.request.use((config) => {
      config.headers = AxiosHeaders.from(config.headers);
      const t = localStorage.getItem("auth_token");
      if (t) (config.headers as AxiosHeaders).set("Authorization", `Bearer ${t}`);
      return config;
    });
    return i;
  }, []);

  const addDisk = () =>
    setDisks((d) => [
      ...d,
      { name: `data-${d.length}`, lun: d.length, caching: "ReadWrite", disk_size_gb: 128 },
    ]);

  const removeDisk = (idx: number) => setDisks((d) => d.filter((_, i) => i !== idx));
  const updateDisk = (idx: number, patch: Partial<Disk>) =>
    setDisks((d) => d.map((x, i) => (i === idx ? { ...x, ...patch } : x)));

  // --- Snapshot fetcher (filtered by course) ---
  const fetchSnapshots = async (q: string) => {
    setSnapLoading(true);
    try {
      const params: Record<string, string> = { course };
      if (q) params.q = q;

      // FIX: use the snapshots API and pass course so backend filters
      const res = await api.get("/api/snapshots", { params });
      const items: SnapshotItem[] = (res.data?.snapshots ?? []).map((s: any) => ({
        name: s.name,
        id: s.id,
        time_created: s.time_created,
        sku: s.sku,
        provisioning_state: s.provisioning_state,
      }));
      setSnapshots(items);
    } catch (e: any) {
      toast({
        variant: "destructive",
        title: "Failed to load snapshots",
        description: e?.response?.data?.error || e?.message,
      });
    } finally {
      setSnapLoading(false);
    }
  };

  // initial load of latest snapshots
  useEffect(() => {
    fetchSnapshots("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [course]); // re-run if course changes

  // re-fetch when query changes
  useEffect(() => {
    fetchSnapshots(debouncedQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, course]);

  const handleSubmit = async () => {
    if (!selectedSnapshot?.id || !vmSize || vmCount <= 0) {
      toast({
        variant: "destructive",
        title: "Missing fields",
        description: !selectedSnapshot?.id ? "Please select a snapshot." : "Fill all required fields.",
      });
      return;
    }

    const expiresIso = localToUtcIso(expiresLocal);
    if (!expiresIso) {
      toast({
        variant: "destructive",
        title: "Invalid expiry",
        description: "Please pick a valid expiry date/time.",
      });
      return;
    }
    if (new Date(expiresIso).getTime() <= Date.now()) {
      toast({
        variant: "destructive",
        title: "Expiry must be in the future",
        description: "Choose a later date/time.",
      });
      return;
    }

    setLoading(true);
    try {
      const payload = {
        course,
        lab_name: labName, // keep the full name with .tfstate for backend/backend.tf
        module_name: "WindowsSnapshot",
        expires_at: expiresIso, // 👈 top-level (UTC ISO)
        params: {
          vm_count: vmCount,
          vm_size: vmSize,
          snapshot_id: selectedSnapshot.id, // 👈 from picker
          data_disks: disks,
        },
      };

      const res = await api.post("/api/labs/create", payload);

      toast({
        title: "Terraform Lab Created",
        description: res?.data?.merge_request_url ? (
          <a
            href={res.data.merge_request_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline"
          >
            View Merge Request in GitLab
          </a>
        ) : (
          "Merge request created in GitLab."
        ),
      });

      onDone(res.data);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || "Failed to create lab.";
      toast({ variant: "destructive", title: "Error", description: msg });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Info */}
      <Card className="p-4">
        <div className="text-sm text-muted-foreground">
          <div>
            <span className="font-medium text-foreground">Course:</span> {course}
          </div>
          <div>
            <span className="font-medium text-foreground">Lab:</span> {cleanedLab}
          </div>
          <div>
            <span className="font-medium text-foreground">Module:</span> Snapshot Virtual Machine
          </div>
        </div>
      </Card>

      {/* VM Name derived */}
      <div className="space-y-2">
        <Label>VM Name (derived)</Label>
        <Input value={derivedVmName} readOnly />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* VM Count */}
        <div className="space-y-2">
          <Label>VM Count *</Label>
          <Input
            type="number"
            min={1}
            value={vmCount}
            onChange={(e) => setVmCount(Number(e.target.value || 0))}
          />
        </div>

        {/* VM Size */}
        <div className="space-y-2">
          <Label>VM Size *</Label>
          <Select value={vmSize} onValueChange={setVmSize}>
            <SelectTrigger><SelectValue placeholder="Select size" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="Standard_D2s_v5">Standard_D2s_v5</SelectItem>
              <SelectItem value="Standard_D4s_v5">Standard_D4s_v5</SelectItem>
              <SelectItem value="Standard_B2ms">Standard_B2ms</SelectItem>
              <SelectItem value="Standard_D2s_v3">Standard_D2s_v3</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Snapshot Picker */}
        <div className="md:col-span-2 space-y-2">
          <Label>Choose Snapshot *</Label>

          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Search snapshots (by name)…"
                value={snapQuery}
                onChange={(e) => setSnapQuery(e.target.value)}
              />
            </div>
            <Button variant="outline" type="button" onClick={() => fetchSnapshots(debouncedQuery)} disabled={snapLoading}>
              <RefreshCw className={`h-4 w-4 ${snapLoading ? "animate-spin" : ""}`} />
            </Button>
          </div>

          <div className="border rounded-md max-h-56 overflow-auto mt-2">
            {snapLoading ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Loading snapshots…
              </div>
            ) : snapshots.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">No snapshots found.</div>
            ) : (
              <ul className="divide-y">
                {snapshots.map((s) => {
                  const selected = s.id === selectedSnapshot?.id;
                  return (
                    <li
                      key={s.id}
                      className={`px-3 py-2 cursor-pointer flex items-center justify-between hover:bg-accent/50 ${
                        selected ? "bg-primary/10" : ""
                      }`}
                      onClick={() => setSelectedSnapshot(s)}
                    >
                      <div className="min-w-0">
                        <div className="font-medium truncate">{s.name}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {s.time_created ? new Date(s.time_created).toLocaleString() : "—"}
                          {s.sku ? ` • ${s.sku}` : "" }
                          {s.provisioning_state ? ` • ${s.provisioning_state}` : ""}
                        </div>
                      </div>
                      {selected ? (
                        <Badge variant="secondary" className="ml-3 inline-flex items-center gap-1">
                          <CheckCircle2 className="h-3 w-3" /> Selected
                        </Badge>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {selectedSnapshot ? (
            <p className="text-xs text-muted-foreground">
              Using snapshot: <code>{selectedSnapshot.name}</code>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">Select a snapshot to continue.</p>
          )}
        </div>

        {/* Expiry */}
        <div className="md:col-span-2 space-y-2">
          <Label>Expires At *</Label>
          <Input
            type="datetime-local"
            value={expiresLocal}
            onChange={(e) => setExpiresLocal(e.target.value)}
            min={defaultLocalDateTime(1)} // prevent past selection
          />
          <p className="text-xs text-muted-foreground">
            Pick the date & time this lab should expire (your local time). It will be stored in UTC.
          </p>
        </div>
      </div>

      {/* Optional data disks */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label>Data Disks (optional)</Label>
          <Button type="button" variant="secondary" onClick={addDisk}>
            <Plus className="w-4 h-4 mr-1" /> Add Disk
          </Button>
        </div>

        {disks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No additional data disks.</p>
        ) : (
          <div className="space-y-3">
            {disks.map((d, i) => (
              <Card key={i} className="p-3">
                <div className="grid grid-cols-1 sm-grid-cols-5 md:grid-cols-5 gap-2">
                  <div className="space-y-1">
                    <Label>Name</Label>
                    <Input value={d.name} onChange={(e) => updateDisk(i, { name: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label>LUN</Label>
                    <Input
                      type="number"
                      min={0}
                      value={d.lun}
                      onChange={(e) => updateDisk(i, { lun: Number(e.target.value || 0) })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Caching</Label>
                    <Select value={d.caching} onValueChange={(v: any) => updateDisk(i, { caching: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ReadWrite">ReadWrite</SelectItem>
                        <SelectItem value="ReadOnly">ReadOnly</SelectItem>
                        <SelectItem value="None">None</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label>Size (GB)</Label>
                    <Input
                      type="number"
                      min={1}
                      value={d.disk_size_gb}
                      onChange={(e) => updateDisk(i, { disk_size_gb: Number(e.target.value || 0) })}
                    />
                  </div>
                  <div className="flex items-end">
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => removeDisk(i)}
                      className="w-full"
                    >
                      <Trash2 className="w-4 h-4 mr-1" /> Remove
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <div className="flex gap-3">
        <Button type="button" variant="outline" onClick={onBack}>
          Previous
        </Button>
        <Button className="ml-auto" onClick={handleSubmit} disabled={loading || !selectedSnapshot}>
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Creating…
            </>
          ) : (
            "Create Lab"
          )}
        </Button>
      </div>
    </div>
  );
}
