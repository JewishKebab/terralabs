import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Package, Server, Database, Network, ChevronLeft, Image, Camera } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ModuleSelectionProps {
  onComplete: (module: string) => void;
  onBack?: () => void;
}

export function ModuleSelection({ onComplete, onBack }: ModuleSelectionProps) {
  const [selectedModule, setSelectedModule] = useState("");
  const { toast } = useToast();

  // Mock data - in production, these would be loaded from source code
  const modules = [
    {
      id: "vm-module",
      name: "Virtual Machine",
      description: "Deploy Azure Virtual Machines",
      icon: Server,
      color: "text-blue-500",
    },
    {
      id: "storage-module",
      name: "Storage Account",
      description: "Create Azure Storage resources",
      icon: Database,
      color: "text-green-500",
    },
    {
      id: "network-module",
      name: "Virtual Network",
      description: "Configure Azure networking",
      icon: Network,
      color: "text-purple-500",
    },
    {
      id: "container-module",
      name: "Container Instance",
      description: "Deploy containerized applications",
      icon: Package,
      color: "text-orange-500",
    },
    {
      id: "lab-from-image",
      name: "Lab from Image",
      description: "Create lab environment from image",
      icon: Image,
      color: "text-cyan-500",
    },
    {
      id: "lab-from-snapshot",
      name: "Lab from Snapshot",
      description: "Create lab environment from snapshot",
      icon: Camera,
      color: "text-pink-500",
    },
  ];

  const handleSubmit = () => {
    if (!selectedModule) {
      toast({
        title: "Selection Required",
        description: "Please select a module to continue.",
        variant: "destructive",
      });
      return;
    }

    toast({
      title: "Module Selected",
      description: `Using module: ${selectedModule}`,
    });

    onComplete(selectedModule);
  };

  return (
    <div className="space-y-6">
      <Label>Select Terraform Module</Label>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {modules.map((module) => {
          const Icon = module.icon;
          return (
            <Card
              key={module.id}
              className={`p-6 cursor-pointer transition-all hover:shadow-md ${
                selectedModule === module.name
                  ? "border-primary shadow-glow"
                  : ""
              }`}
              onClick={() => setSelectedModule(module.name)}
            >
              <div className="flex flex-col items-center text-center gap-3">
                <div className="h-12 w-12 rounded-lg bg-gradient-primary flex items-center justify-center shadow-glow">
                  <Icon className="h-6 w-6 text-primary-foreground" />
                </div>
                <div>
                  <h3 className="font-semibold mb-1">{module.name}</h3>
                  <p className="text-sm text-muted-foreground">
                    {module.description}
                  </p>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <div className="flex gap-3">
        {onBack && (
          <Button 
            onClick={onBack} 
            variant="outline"
            className="flex-1"
          >
            <ChevronLeft className="mr-2 h-4 w-4" />
            Previous
          </Button>
        )}
        <Button 
          onClick={handleSubmit} 
          disabled={!selectedModule}
          className="flex-1"
        >
          Continue to Parameters
        </Button>
      </div>
    </div>
  );
}
