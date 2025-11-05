import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BackendSelection, LabInfo } from "./steps/BackendSelection";
import { ModuleSelection } from "./steps/ModuleSelection";
import ParameterConfiguration from "./steps/ParameterConfiguration";

const steps = [
  { id: 1, name: "Backend", description: "Choose or create lab" },
  { id: 2, name: "Module", description: "Select module" },
  { id: 3, name: "Parameters", description: "Configure parameters" },
];

export function ProvisioningStepper() {
  const [currentStep, setCurrentStep] = useState(1);
  const [lab, setLab] = useState<LabInfo | null>(null);
  const [moduleName, setModuleName] = useState<string | null>(null);

  return (
    <div className="space-y-8">
      <Card className="shadow-elegant">
        <CardHeader>
          <CardTitle>{steps[currentStep - 1].name}</CardTitle>
          <CardDescription>{steps[currentStep - 1].description}</CardDescription>
        </CardHeader>
        <CardContent>
          {currentStep === 1 && (
            <BackendSelection
              onComplete={(info) => {
                setLab(info);
                setCurrentStep(2);
              }}
            />
          )}

          {currentStep === 2 && (
            <ModuleSelection
              onComplete={(m) => {
                setModuleName(m);
                setCurrentStep(3);
              }}
              onBack={() => setCurrentStep(1)}
            />
          )}

          {currentStep === 3 && lab && moduleName && (
            <ParameterConfiguration
              course={lab.course}
              labName={`${lab.labName}.tfstate`}  // keep .tfstate for backend paths
              selectedModule={moduleName === "vm-snapshot-module" ? "WindowsSnapshot" : moduleName}
              onBack={() => setCurrentStep(2)}
              onDone={() => {/* maybe navigate/clear */}}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
