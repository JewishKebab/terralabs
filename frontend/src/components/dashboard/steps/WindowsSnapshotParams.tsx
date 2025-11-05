import { useMemo, useState } from "react";
import axios, { AxiosHeaders } from "axios";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectTrigger, SelectContent, SelectItem, SelectValue,
} from "@/components/ui/select";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus, Trash2 } from "lucide-react";

type Disk = {
  name: string;
  lun: number;
  caching: "ReadWrite" | "ReadOnly" | "None";
  disk_size_gb: number;
};

export default function WindowsSnapshotParams({
  course,          // e.g. "devops"
  labName,         // e.g. "win-snap-lab1"
  onBack,          // () => void
  onDone,          // (r:any) => void
}: {
  course: string;
  labName: string;
  onBack: () => void;
  onDone: (r: any) => void;
}) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);

  // form state
  const [vmName, setVmName] = useState("labvm");
  const [vmCount, setVmCount] = useState<number>(1);
  const [vmSize, setVmSize] = useState("Standard_D2s_v5");
  const [rgName, setRgName] = useState("");
  const [subnetId, setSubnetId] = useState("");
  const [snapshotId, setSnapshotId] = useState("");
  const [disks, setDisks] = useState<Disk[]>([]);

  const api = useMemo(() => {
    const i = axios.create({
      baseURL: "http://localhost:5000",
      headers: new AxiosHeaders({ "Content-Type": "application/json" }),
      timeout: 20000,
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

  const handleSubmit = async () => {
    if (!vmName || !rgName || !subnetId || !snapshotId || !vmSize || vmCount <= 0) {
      toast({ variant: "destructive", title: "Missing fields", description: "Fill all required fields." });
      return;
    }

    setLoading(true);
    try {
      const payload = {
        course,
        lab_name: labName,
        module_name: "WindowsSnapshot",
        params: {
          vm_name: vmName,
          vm_count: vmCount,
          vm_size: vmSize,
          resource_group_name: rgName,
          subnet_id: subnetId,
          os_snapshot_id: snapshotId,
          data_disks: disks, // [] by default
        },
      };

      const res = await api.post("/api/labs/create", payload);
      toast({ title: "Lab created", description: res?.data?.lab_path ?? "Pushed to GitLab." });
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
      <Card className="p-4">
        <div className="text-sm text-muted-foreground">
          <div><span className="font-medium text-foreground">Course:</span> {course}</div>
          <div><span className="font-medium text-foreground">Lab:</span> {labName}</div>
          <div><span className="font-medium text-foreground">Module:</span> Snapshot Virtual Machine</div>
        </div>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="vm_name">VM Base Name *</Label>
          <Input id="vm_name" value={vmName} onChange={(e) => setVmName(e.target.value)} placeholder="labvm" />
        </div>

        <div className="space-y-2">
          <Label htmlFor="vm_count">VM Count *</Label>
          <Input id="vm_count" type="number" min={1} value={vmCount}
                 onChange={(e) => setVmCount(Number(e.target.value || 0))} />
        </div>

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

        <div className="space-y-2">
          <Label htmlFor="rg">Resource Group *</Label>
          <Input id="rg" value={rgName} onChange={(e) => setRgName(e.target.value)} placeholder="rg-terralabs-we" />
        </div>

        <div className="md:col-span-2 space-y-2">
          <Label htmlFor="subnet">Subnet ID *</Label>
          <Textarea id="subnet" value={subnetId} onChange={(e) => setSubnetId(e.target.value)}
                    placeholder="/subscriptions/.../resourceGroups/.../providers/Microsoft.Network/virtualNetworks/.../subnets/..." />
        </div>

        <div className="md:col-span-2 space-y-2">
          <Label htmlFor="snap">OS Snapshot Resource ID *</Label>
          <Textarea id="snap" value={snapshotId} onChange={(e) => setSnapshotId(e.target.value)}
                    placeholder="/subscriptions/.../resourceGroups/.../providers/Microsoft.Compute/snapshots/..." />
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label>Data Disks (optional)</Label>
          <Button type="button" variant="secondary" onClick={addDisk}><Plus className="w-4 h-4 mr-1" /> Add Disk</Button>
        </div>

        {disks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No additional data disks.</p>
        ) : (
          <div className="space-y-3">
            {disks.map((d, i) => (
              <Card key={i} className="p-3">
                <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
                  <div className="space-y-1">
                    <Label>Name</Label>
                    <Input value={d.name} onChange={(e) => updateDisk(i, { name: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label>LUN</Label>
                    <Input type="number" min={0} value={d.lun}
                           onChange={(e) => updateDisk(i, { lun: Number(e.target.value || 0) })} />
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
                    <Input type="number" min={1} value={d.disk_size_gb}
                           onChange={(e) => updateDisk(i, { disk_size_gb: Number(e.target.value || 0) })} />
                  </div>
                  <div className="flex items-end">
                    <Button type="button" variant="destructive" onClick={() => removeDisk(i)} className="w-full">
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
        <Button type="button" variant="outline" onClick={onBack}>Previous</Button>
        <Button className="ml-auto" onClick={handleSubmit} disabled={loading}>
          {loading ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Creating…</>) : "Create GitLab Request"}
        </Button>
      </div>
    </div>
  );
}
