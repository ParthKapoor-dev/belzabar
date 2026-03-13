# NSM.md — Notice & Storage System Domain Reference

## Overview

**NSM** (North Carolina — Notice & Storage System) manages the lifecycle of abandoned/stored vehicles reported by garages to the DMV. It tracks vehicle notices, owner notifications, and garage requests through a series of standardized letters (LT-xxx).

See `BELZABAR.md` in this directory for general platform context (environments, AD/PD tools, migration workflow).

---

## Portal Types

NSM has two portals, consistent with all Belzabar projects:

### Public Portal (`PORTAL`)

- **Users**: **INDIVIDUALS** (vehicle owners) and **GARAGES**
- **Dev URL**: `https://nsm-dev-public.nc.verifi.dev/`

### Staff Portal (`STAFF`)

- **Users**: DMV staff
- **Dev URL**: `https://nsm-dev.nc.verifi.dev/`

---

## Database

Primary tables:

- **`application`** — top-level record per vehicle/case
- **`application_form_details`** — form field data tied to an application

Many additional tables exist. These two are the main entry points for most queries.

---

## Flows (Letter Sequences)

NSM processes follow a defined sequence of letters exchanged between garages (PP), DMV (STAFF), and system-generated end states.

| Sender  | Letter        | Description                                                                 |
|---------|---------------|-----------------------------------------------------------------------------|
| PP/DMV  | LT-260        | Garage informs DMV that a vehicle has been left on their premises           |
| DMV     | LT-160B       | DMV acknowledges receipt of the application to the garage                   |
| DMV     | LT-260A       | Notice sent to the vehicle owner that the car has been reported abandoned    |
| DMV     | LT-260C       | Owners and lienholders could not be found for the vehicle                   |
| END     | LT-260D       | DMV informs the garage that the reported vehicle is stolen                  |
| PP      | LT-262        | Garage requests DMV permission to sell the vehicle                          |
| DMV     | LT-262B       | Owner/lienholder not found (in context of sale request)                     |
| DMV     | LT-264        | Notice to vehicle owner: must respond within 30 days                        |
| DMV     | LT-264 Garage | Copy of LT-264 sent to the garage                                           |
| DMV     | LT-264A       | Owner did not respond within the timeframe — issue moved to court           |
| DMV     | LT-264B       | Owner disputes the garage's sale request — issue moved to court             |
| PP      | LT-263        | Garage requests a date of sale                                              |
| DMV     | LT-265        | DMV approves the sale of the vehicle                                        |

### Sender Key

- **PP** — Public Portal (garage-initiated action)
- **DMV** — Staff Portal (DMV-initiated action)
- **END** — System/end-state generated (no further user action expected)
