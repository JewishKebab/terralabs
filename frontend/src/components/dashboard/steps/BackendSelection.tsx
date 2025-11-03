import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Card } from "@/components/ui/card";
import { Database, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface BackendSelectionProps {
  onComplete: (backend: string) => void;
}

export function BackendSelection({ onComplete }: BackendSelectionProps) {
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [selectedBackend, setSelectedBackend] = useState("");
  const [newBackendName, setNewBackendName] = useState("");
  const { toast } = useToast();

  // Mock data - in production, this would come from Azure Storage
  const existingBackends = [
    { id: "1", name: "production-backend", lastModified: "2024-01-15" },
    { id: "2", name: "staging-backend", lastModified: "2024-01-14" },
    { id: "3", name: "dev-backend", lastModified: "2024-01-10" },
  ];

  const handleSubmit = () => {
    const backend = mode === "new" ? newBackendName : selectedBackend;
    
    if (!backend) {
      toast({
        title: "Selection Required",
        description: "Please select or create a backend to continue.",
        variant: "destructive",
      });
      return;
    }

    toast({
      title: "Backend Selected",
      description: `Using backend: ${backend}`,
    });

    onComplete(backend);
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
          <div className="space-y-2">
            {existingBackends.map((backend) => (
              <Card
                key={backend.id}
                className={`p-4 cursor-pointer transition-all hover:shadow-md ${
                  selectedBackend === backend.name
                    ? "border-primary shadow-glow"
                    : ""
                }`}
                onClick={() => setSelectedBackend(backend.name)}
              >
                <div className="flex items-center gap-3">
                  <Database className="h-5 w-5 text-primary" />
                  <div className="flex-1">
                    <p className="font-medium">{backend.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Last modified: {backend.lastModified}
                    </p>
                  </div>
                </div>
              </Card>
            ))}
          </div>
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
            <Button variant="outline" size="icon">
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            This will create a new tfstate backend in your Azure Storage account.
          </p>
        </div>
      )}

      <Button onClick={handleSubmit} className="w-full">
        Continue to Module Selection
      </Button>
    </div>
  );
}
