import { useState } from "react";
import axios from "axios";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

interface Props {
  backend: string;
  module: string;
  onBack: () => void;
  onComplete: () => void;
}

export default function ParameterConfiguration({
  backend,
  module,
  onBack,
  onComplete,
}: Props) {
  const { toast } = useToast();

  // Form state for Windows Snapshot module
  const [vmName, setVmName] = useState("");
  const [vmCount, setVmCount] = useState(1);
  const [vmSize, setVmSize] = useState("Standard_DS2_v2");
  const [snapshotId, setSnapshotId] = useState("");

  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!vmName || !snapshotId) {
      toast({
        title: "Missing Required Values",
        description: "Please fill in all fields.",
        variant: "destructive",
      });
      return;
    }

    try {
      setLoading(true);
      const token = localStorage.getItem("auth_token");

      await axios.post(
        "http://localhost:5000/api/labs",
        {
          backend_name: backend,
          course_name: "devops", // Hardcoded for now until UI selection
          module_name: module,
          parameters: {
            vm_name: vmName,
            vm_count: vmCount,
            vm_size: vmSize,
            snapshot_id: snapshotId,
          },
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      toast({
        title: "Terraform Lab Created",
        description: "Merge request created in GitLab.",
      });

      onComplete();
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: err?.response?.data?.error || "Failed to create lab.",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="bg-muted p-4 rounded-md text-sm text-muted-foreground">
        <div><strong>Backend:</strong> {backend}</div>
        <div><strong>Module:</strong> {module}</div>
      </div>

      {/* VM Name */}
      <div className="space-y-2">
        <Label>VM Name *</Label>
        <Input
          placeholder="lab-vm"
          value={vmName}
          onChange={(e) => setVmName(e.target.value)}
        />
      </div>

      {/* VM Count */}
      <div className="space-y-2">
        <Label>VM Count *</Label>
        <Input
          type="number"
          value={vmCount}
          min={1}
          onChange={(e) => setVmCount(Number(e.target.value))}
        />
      </div>

      {/* VM Size */}
      <div className="space-y-2">
        <Label>VM Size *</Label>
        <Input
          placeholder="Standard_DS2_v2"
          value={vmSize}
          onChange={(e) => setVmSize(e.target.value)}
        />
      </div>

      {/* Snapshot ID */}
      <div className="space-y-2">
        <Label>Snapshot Resource ID *</Label>
        <Input
          placeholder="/subscriptions/.../resourceGroups/.../providers/Microsoft.Compute/snapshots/yourSnapshot"
          value={snapshotId}
          onChange={(e) => setSnapshotId(e.target.value)}
        />
      </div>

      {/* Buttons */}
      <div className="flex justify-between pt-4">
        <Button variant="outline" onClick={onBack}>
          ← Back
        </Button>

        <Button onClick={handleSubmit} disabled={loading}>
          {loading ? "Creating..." : "Create GitLab Merge Request"}
        </Button>
      </div>
    </div>
  );
}
