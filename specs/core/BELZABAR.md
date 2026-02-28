# CONTEXT.md - Belzabar Software Engineering Internship

## Company Overview

**Belzabar** is a company that develops portals, automations, and related systems for the Department of Motor Vehicles (DMV) in the United States, particularly for New York, North Carolina, and other states.

### Projects
The company maintains multiple projects for the US government, including:
- **ACH**
- **NSM** (North Carolina - Notice & Storage System)
- **YieldSec**

---

## Proprietary Tools

Belzabar has developed proprietary tools for building these government systems:

### 1. Automation Designer (AD)
- **Purpose**: API/Method automation tool that chains different services with inputs/outputs
- **Comparison**: Similar to N8N, but closed source with a less intuitive interface
- **Access Key**: `/automation-designer/`

### 2. Page Designer (PD)
- **Purpose**: Frontend designer tool requiring manual state management
- **Comparison**: Similar to WordPress, but more difficult to debug and maintain
- **Access Key**: `/ui-designer/`

### 3. Report Designer
- **Purpose**: Report generation tool for government documentation
- **Implementation**: Uses methods (typically named `X.datasource`) to fetch and display data in tabular format
- **Note**: One of the better-implemented proprietary tools

---

## Current Project: NSM (North Carolina - Notice & Storage System)

### Portal Types
Each project typically includes two types of portals:

1. **Staff Portal**: For DMV users
2. **Public Portal**: For general civilians or specific entities (e.g., Garages in NSM)

---

## Environment Structure

The development workflow uses five distinct environments:

### 1. Dev Environment
- **Purpose**: Primary environment for developing features and fixes
- **Users**: Developers (majority of work happens here)
- **Example URL**: `https://nsm-dev.nc.verifi.dev/`

### 2. QA Environment
- **Purpose**: Testing environment for QA engineers to validate features/fixes
- **Users**: QA engineers (primary), Developers (for debugging migration issues)
- **Example URL**: `https://nsm-qa.nc.verifi.dev/`
- **Note**: If an issue doesn't exist in Dev but appears in QA, it's likely a migration issue

### 3. UAT Environment
- **Purpose**: User Acceptance Testing environment
- **Users**: Project Managers (PMs) and Business Analysts (BAs)
- **Example URL**: `https://nsm-uat.nc.verifi.dev/`

### 4. Stage Environment
- **Purpose**: Pre-production staging environment
- **Users**: DevOps team involvement increases here
- **Example URL**: `https://staff-nss-stage.verifi-nc.com/`

### 5. Prod Environment
- **Purpose**: Production environment (live system)
- **Users**: Limited access (interns typically don't have credentials)
- **Note**: Bugs in production are critical issues - hence the multiple staging environments
- **Access**: No credentials or URL available for interns

### Environment Access Notes
- **Dev to Stage**: Both Dev and QA engineers have credentials and may access for validation
- **QA Engineer Role**: QA engineers test and validate features/fixes across all environments (except minimal Dev presence) before approving migration to the next level

---

## Designer Tool Access

The designers are deployed as web portals within staff portals at every environment.

### Access Pattern Example (Dev Environment)

**Base Staff Portal**: `https://nsm-dev.nc.verifi.dev/`

**Designers**:
- Automation Designer: `https://nsm-dev.nc.verifi.dev/automation-designer/`
- Page Designer: `https://nsm-dev.nc.verifi.dev/ui-designer/`
- Report Designer: `https://nsm-dev.nc.verifi.dev/report-designer/`

**Note**: These designer tools generally don't exist on Public portals.

---

## Designer Details

### Automation Designer (AD)

#### Modes and IDs
- Each method exists in **2 modes** with **2 IDs**: Draft and Published
- **Access URLs**:
  - Draft: `nsm-dev.nc.verifi.dev/automation-designer/<Category-Name>/<method-draft-id>`
  - Published: `nsm-dev.nc.verifi.dev/automation-designer/<Category-Name>/<method-published-id>`

#### Workflow
- **Published ID**: Used for API execution and migration to next environment
- **Draft Mode**: Used to make changes, test them, save, and publish
- **Published Mode**: Cannot make changes directly - must use Draft mode first

#### Structure
- **Service Categories**: Organizational groups (e.g., `NSM.Staff`)
- **Methods**: Individual automation methods (e.g., `LT-260.get`)

### Page Designer (PD)

#### Components
Page Designer consists of two main types:

1. **Pages**
   - Access URL: `https://nsm-dev.nc.verifi.dev/ui-designer/page/<draft-id>`
   - Example: `https://nsm-dev.nc.verifi.dev/ui-designer/page/4446632159c2d9b4acf2b4b307aeb367`
   - Accessed via Draft IDs

2. **Components**
   - Access URL: `https://nsm-dev.nc.verifi.dev/ui-designer/symbol/<component-name>`
   - Example: `https://nsm-dev.nc.verifi.dev/ui-designer/symbol/n_s_public_LT_260_Form`
   - Accessed via component names

#### IDs and Workflow
- Both pages and components have Draft and Published IDs
- **Workflow**: Changes are made in Draft mode, then published to make them visible in the UI

---

## Migration Process

### Migration Tool
Developers use a migration tool to migrate AD methods or PD pages to the next environment using their Published IDs.

**Migration Tool URL**: `https://db-migration-tool.services.stage.expertly.cloud/index.html#/NCDNS%3A%20Migrate%20Source%20DB%20to%20Target%20DB`

### Migration Workflow
1. Developer makes changes and writes a dev-note as a comment
2. Senior developer reviews the changes
3. Developer migrates to next environment
4. QA engineers validate on that environment
5. Upon validation, migration proceeds to the next environment
6. Process repeats until reaching production

---

## Ticket Management

### Teamwork
- **Platform**: Teamwork project management system
- **URL**: `projects.webintensive.com/`
- **Process**: 
  - New tickets are created in Teamwork
  - Developers add dev-notes as comments for each change made
  - Senior developers review before migration approval

---

## Communication

### Slack
- **Purpose**: Primary communication tool for all team members
- **Usage**: Used for coordination with everyone across the organization

---

## Summary of Key Points

1. **Primary Role**: Software Engineering Intern at Belzabar
2. **Main Project**: NSM (North Carolina - Notice & Storage System)
3. **Primary Environment**: Dev environment (`https://nsm-dev.nc.verifi.dev/`)
4. **Key Tools**: Automation Designer, Page Designer, Report Designer
5. **Workflow**: Dev → QA → UAT → Stage → Prod
6. **Migration**: Uses Published IDs via migration tool
7. **Validation**: QA engineers validate at each environment before next migration
8. **Ticket Tracking**: Teamwork platform
9. **Communication**: Slack
