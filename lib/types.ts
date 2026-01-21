export interface RawMethodResponse {
  uuid: string;
  referenceId: string;
  aliasName: string;
  automationState: "PUBLISHED" | "DRAFT";
  jsonDefinition: string; // The stringified JSON
  createdOn: number;
  lastUpdatedOn: number;
  lastUpdatedBy: string;
  version?: number;
  category?: {
    id: number;
    name: string;
  };
  owner?: {
    id: number;
    username: string;
  };
  // Add other fields as necessary from the API response
}

export interface InputField {
  fieldCode: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface ServiceStep {
  automationId: string;
  orderIndex: number;
  description?: string;
  type: string;
  mappings?: any;
  outputs?: any;
}

export interface InnerDefinition {
  name?: string;
  description?: string;
  summary?: string;
  inputs?: InputField[];
  services?: ServiceStep[];
  // Add other fields extracted from jsonDefinition
}

export interface HydratedMethod {
  // Metadata from Raw
  uuid: string;
  referenceId: string; // The other ID (Published/Draft)
  aliasName: string;
  methodName: string;
  category: string;
  version: number;
  state: "PUBLISHED" | "DRAFT";
  fetchedAt: number;
  
  // Timestamps
  createdOn: number;
  updatedOn: number;
  updatedBy: string;

  // Parsed content
  summary?: string;
  inputs: InputField[];
  services: ServiceStep[];
  
  // Keep original raw just in case?
  // raw: RawMethodResponse; 
}

export interface AutomationUserInput {
  id: string;
  label: string;
  encodingType?: string;
  optional?: boolean;
  orderIndex?: number;
  showOnSDUi?: boolean;
  automationUserInputs?: AutomationUserInput[];
}

export interface AutomationAPIOutput {
  id: string;
  displayName: string;
}

export interface AutomationDefinition {
  uuid: string;
  automationAPI: {
    label: string;
    automationSystem: {
      label: string;
    };
    automationUserInputs?: AutomationUserInput[];
    automationAPIOutputs?: AutomationAPIOutput[];
  };
  automationAuth?: {
    nickname: string;
  };
}
