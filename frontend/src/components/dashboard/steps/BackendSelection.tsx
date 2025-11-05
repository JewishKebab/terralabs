import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

export type LabInfo = {
  course: "devops" | "cyber" | "tichnut";
  labName: string; // plain name, e.g., "step1" (no .tfstate)
};

export function BackendSelection({
  onComplete,
}: {
  onComplete: (lab: LabInfo) => void;
}) {
  const { toast } = useToast();
  const [course, setCourse] = useState<LabInfo["course"]>("devops");
  const [labName, setLabName] = useState("");

  const submit = () => {
    const clean = labName.trim().replace(/\s+/g, "-").toLowerCase();
    if (!clean) {
      toast({ variant: "destructive", title: "Missing lab name", description: "Enter a lab name." });
      return;
    }
    onComplete({ course, labName: clean });
  };

  return (
    <div className="space-y-6">
      <Card className="p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Course</Label>
            <Select value={course} onValueChange={(v) => setCourse(v as LabInfo["course"])}>
              <SelectTrigger><SelectValue placeholder="Select course" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="devops">Devops</SelectItem>
                <SelectItem value="cyber">Cyber</SelectItem>
                <SelectItem value="tichnut">Tichnut</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Lab Name</Label>
            <Input
              placeholder="step1"
              value={labName}
              onChange={(e) => setLabName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              File/state will be stored under <code>{course}/&lt;labName&gt;/terraform.tfstate</code>
            </p>
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={submit}>Continue to Module</Button>
        </div>
      </Card>
    </div>
  );
}
