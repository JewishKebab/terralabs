import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BackendSelection, LabInfo } from "./steps/BackendSelection";
import { ModuleSelection } from "./steps/ModuleSelection";
import ParameterConfiguration from "./steps/ParameterConfiguration";
import ProvisioningPending from "./ProvisioningPending";

const steps = [
  { id: 1, name: "Backend", description: "Choose or create lab" },
  { id: 2, name: "Module", description: "Select module" },
  { id: 3, name: "Parameters", description: "Configure parameters" },
  { id: 4, name: "Pending", description: "Awaiting approval" },
];

type Props = {
  /** When present, only these course ids are allowed (teacher scope). */
  lockToCourses?: string[];
};

export function ProvisioningStepper({ lockToCourses }: Props) {
  const [currentStep, setCurrentStep] = useState(1);
  const [lab, setLab] = useState<LabInfo | null>(null);
  const [moduleName, setModuleName] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const handleProvisioningDone = () => {
    if (!lab) return;
    setPending(true);
    setCurrentStep(4);
  };

  return (
    <div className="space-y-8">
      <Card className="shadow-elegant">
        <CardHeader>
          <CardTitle>{steps[currentStep - 1].name}</CardTitle>
          <CardDescription>{steps[currentStep - 1].description}</CardDescription>
        </CardHeader>
        <CardContent>
          {pending && lab ? (
            <ProvisioningPending course={lab.course} labName={lab.labName} />
          ) : currentStep === 1 ? (
            <BackendSelection
              lockToCourses={lockToCourses}
              onComplete={(info) => {
                setLab(info);
                setCurrentStep(2);
              }}
            />
          ) : currentStep === 2 ? (
            <ModuleSelection
              onComplete={(m) => {
                setModuleName(m);
                setCurrentStep(3);
              }}
              onBack={() => setCurrentStep(1)}
            />
          ) : currentStep === 3 && lab && moduleName ? (
            <ParameterConfiguration
              course={lab.course}
              labName={lab.labName}
              selectedModule={moduleName}
              onBack={() => setCurrentStep(2)}
              onDone={handleProvisioningDone}
            />
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

export default ProvisioningStepper;
