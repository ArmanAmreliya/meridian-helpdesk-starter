# Decision Notes — Part 2: SLA Breach Tracking

**Author:** Arman Amreliya  
**Context:** Bilions Full Stack Developer Internship — Practical Exercise (Part 2)  

---

### Overview
The Product Manager's specification requested SLA breach tracking based on priority targets configured in `server/src/config.js` (`P1: 4h`, `P2: 24h`, `P3: 72h`). The brief left several critical operational and technical questions unanswered. Below are the ambiguities identified, the architectural decisions taken, and the rationale behind each.

---

### 1. What Qualifies as a "Response"?
- **The Ambiguity:** The specification states: *"If we have not responded within the target, the ticket is breached"*, but does not define what action constitutes a response.
- **Decision:** A response is defined strictly as the earliest non-internal comment authored by support staff (`users.role IN ('agent', 'admin') AND comments.is_internal = 0`).
- **Rationale:** 
  1. Requesters frequently add follow-up comments, clarifications, or logs immediately after opening a ticket. Counting customer comments as a "response" would cause unserviced tickets to be falsely marked as compliant.
  2. Internal notes (`is_internal = 1`) are private agent discussions and invisible to the customer. A ticket cannot be considered "answered" if the customer has received no communication.

---

### 2. First Response Time (FRT) vs. Ticket Resolution SLA
- **The Ambiguity:** The spec does not specify whether the 4h / 24h / 72h thresholds measure time to first response or time to full resolution.
- **Decision:** Implemented as a **First Response SLA**.
- **Rationale:** The problem statement explicitly notes: *"Support wants to know which tickets have gone unanswered too long."* In standard ITSM/helpdesk practice, targets of 4h/24h/72h map directly to First Response Time (FRT). Once a support engineer has provided an initial reply, the ticket is no longer "unanswered", though it may remain open during ongoing investigation.

---

### 3. Handling of Resolved and Closed Tickets
- **The Ambiguity:** Should tickets that were resolved or closed without timely responses remain flagged as breached?
- **Decision:** Breach status is computed deterministically for all tickets:
  - If a ticket received an agent response, it is breached if `first_response_at > created_at + target_hours`.
  - If a ticket received no agent response, it is breached if `NOW() > created_at + target_hours`.
  - The list filter `?breached=true` allows support to view breached tickets in combination with existing status filters (e.g. `status=open&breached=true` to find urgent unhandled work).
- **Rationale:** Historical reporting requires knowing whether an SLA was honored even after resolution, while day-to-day triage requires filtering active queues.

---

### 4. Database-Level Computation vs. Application-Level Iteration
- **The Ambiguity:** The spec was silent on whether SLA status should be calculated in Node.js or in MySQL.
- **Decision:** Implemented as a single-pass joined SQL subquery in `ticketService.js` rather than looping in JavaScript.
- **Rationale:** Computing breach status in SQL allows `WHERE is_breached = 1` to be executed by MySQL directly. This ensures:
  1. Accurate pagination (`COUNT(*) AS total` reflects the filtered set).
  2. No N+1 query overhead or fetching entire datasets into Node.js memory.
  3. Consistent millisecond-level timestamp comparisons without round-trip network serialization latency.

---

### 5. How Part 1 Findings Shaped Part 2 Architecture
Three specific discoveries from the Part 1 code review directly influenced how Part 2 was built:
1. **Timezone Alignment (Part 1 Finding 12):** We noted in Part 1 that the Docker environment runs in `Asia/Kolkata (+05:30)` while manual date strings used UTC. To avoid timezone discrepancies distorting SLA calculations by 5.5 hours, all date interval arithmetic was implemented directly inside MySQL (`DATE_ADD(t.created_at, INTERVAL ... HOUR)` and `NOW()`).
2. **Multi-Tenant Scoping (Part 1 Finding 1):** The SLA subquery and breached filter strictly enforce `t.org_id = ?`, ensuring breach statistics and filtered lists never cross customer organisation boundaries.
3. **Pagination Offsets (Part 1 Finding 5):** The corrected `(pageNum - 1) * PAGE_SIZE` formula ensured that filtering by breached tickets immediately displays the top 20 most recent breached tickets on Page 1 instead of skipping them.
