/**
 * TYPES
 */

export interface PageConfigResponse {
  name: string;
  configuration: string; // Stringified JSON
}

export interface ComponentSearchItem {
  id: string;
  name: string;
}

export interface LayoutNode {
  name?: string;
  children?: LayoutNode[];
}

export interface InternalConfig {
  httpRequests?: {
    userDefined?: Array<{
      request?: {
        url?: string;
      };
    }>;
  };
  layout?: LayoutNode;
}

export interface ReportNode {

  type: 'PAGE' | 'COMPONENT';

  name: string;

  id: string;

  adIds: string[];

  children: ReportNode[];

}



export interface RogueIdInfo {

  id: string;

  foundIn: string[];

}



export interface ComplianceResult {



  isCompliant: boolean;



  rogueIds: RogueIdInfo[];



  missingIds: string[]; // In Master but NOT in Generated



  commonIds: string[];  // In both



}




