import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Server, Database, ChevronLeft } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ModuleSelectionProps {
  onComplete: (module: string) => void;
  onBack?: () => void;
}

type ModuleItem = {
  key: string;          // internal key used by the app (what onComplete should get)
  name: string;         // display name
  description: string;
  icon: React.ComponentType<{ className?: string }>;
};

export function ModuleSelection({ onComplete, onBack }: ModuleSelectionProps) {
  const [selectedKey, setSelectedKey] = useState<string>("");
  const { toast } = useToast();

  // Display can say whatever you want; the key must match your router ("WindowsSnapshot")
  const modules: ModuleItem[] = [
    {
      key: "WindowsSnapshot", // <-- IMPORTANT: this is what ParameterConfiguration checks
      name: "Snapshot Virtual Machine",
      description: "Deploy Azure Virtual Machines From Snapshot",
      icon: Server,
    },
    {
      key: "WindowsImage",    // placeholder for future
      name: "Image Virtual Machine",
      description: "Deploy Azure Virtual Machines From Image",
      icon: Database,
    },
  ];

  const handleSubmit = () => {
    if (!selectedKey) {
      toast({
        title: "Selection Required",
        description: "Please select a module to continue.",
        variant: "destructive",
      });
      return;
    }

    const selected = modules.find((m) => m.key === selectedKey)!;
    toast({
      title: "Module Selected",
      description: `Using module: ${selected.name}`,
    });

    onComplete(selectedKey); // <-- pass the KEY, not the display name
  };

  return (
    <div className="space-y-6">
      <Label>Select Terraform Module</Label>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {modules.map((m) => {
          const Icon = m.icon;
          const isSelected = selectedKey === m.key;
          return (
            <Card
              key={m.key}
              className={`p-6 cursor-pointer transition-all hover:shadow-md ${
                isSelected ? "border-primary shadow-glow" : ""
              }`}
              onClick={() => setSelectedKey(m.key)}
            >
              <div className="flex flex-col items-center text-center gap-3">
                <div className="h-12 w-12 rounded-lg bg-gradient-primary flex items-center justify-center shadow-glow">
                  <Icon className="h-6 w-6 text-primary-foreground" />
                </div>
                <div>
                  <h3 className="font-semibold mb-1">{m.name}</h3>
                  <p className="text-sm text-muted-foreground">{m.description}</p>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <div className="flex gap-3">
        {onBack && (
          <Button onClick={onBack} variant="outline" className="flex-1">
            <ChevronLeft className="mr-2 h-4 w-4" />
            Previous
          </Button>
        )}
        <Button onClick={handleSubmit} disabled={!selectedKey} className="flex-1">
          Continue to Parameters
        </Button>
      </div>
    </div>
  );
}
