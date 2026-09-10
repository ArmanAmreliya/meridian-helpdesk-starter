# Codebase Review — Meridian Helpdesk

**Author:** Arman Amreliya  
**Context:** Pull Request Review for Meridian Helpdesk Starter  
**Scope:** Architecture, Security, Data Isolation, and Functional Correctness  

---

## Ranked Findings Summary

The findings below represent a comprehensive code review of the pull request, ordered strictly from highest to lowest severity based on their concrete risk to a multi-tenant customer support desk.

| Rank | Severity | Location | Summary | Primary Risk |
|:---:|:---:|:---|:---|:---|
| **1** | **Critical** | `server/src/routes/tickets.js:33, 64, 77-79`<br>`server/src/services/ticketService.js:57-67, 89-106` | **Cross-Tenant Data Exposure & Modification (IDOR)**: Ticket retrieval, assignment, and deletion operations fail to filter by organisation ID (`org_id`). | Breach of multi-tenant confidentiality and data integrity between customer organisations. |
| **2** | **Critical** | `server/src/services/ticketService.js:38`<br>`server/src/routes/tickets.js:22-23` | **SQL Injection in Ticket Listing**: User-supplied `sortBy` and `order` query parameters are concatenated directly into raw SQL statements. | Remote database compromise, credential dumping, and full tenant data leakage. |
| **3** | **Critical** | `client/src/features/tickets/TicketDetail.jsx:65` | **Stored Cross-Site Scripting (XSS)**: Unsanitized ticket comment bodies are injected directly into the DOM using `dangerouslySetInnerHTML`. | Session hijacking, JWT theft from `localStorage`, and forced administrative actions. |
| **4** | **High** | `server/src/routes/tickets.js:62, 75`<br>`client/src/features/tickets/TicketDetail.jsx:56` | **Missing Role Authorization on Privileged Ticket Endpoints**: Ticket deletion and assignment lack role checks; Claim button displayed to requesters. | Vertical privilege escalation allowing regular requesters to delete or reassign any ticket. *(Related to Finding 1)* |
| **5** | **High** | `server/src/services/ticketService.js:29` | **Pagination Offset Formula Skips Page 1**: Offset formula `page * PAGE_SIZE` produces `OFFSET 20` when requesting the default first page. | Functional defect hiding the 20 newest tickets from users upon loading the system. |
| **6** | **High** | `server/src/routes/auth.js:44-50` | **Account Takeover & Plaintext Password Storage**: `/api/auth/invite/accept` accepts arbitrary user IDs without tokens and stores raw plaintext passwords. | Critical authentication compromise, account hijacking, and login lockout. |
| **7** | **Medium** | `server/src/services/ticketService.js:69-78`<br>`server/src/routes/comments.js:24` | **Internal Agent Notes Leaked to Requesters**: Comment fetching does not filter out `is_internal = 1` for requester accounts. | Information disclosure of confidential internal discussions to end customers. |
| **8** | **Medium** | `server/src/services/ticketService.js:93-100` | **Concurrency Race Condition (TOCTOU) on Ticket Claim**: Assignment checks existing assignee in memory prior to an unconstrained SQL update. | Race condition leading to lost updates and conflicting assignments when agents claim concurrently. |
| **9** | **Medium** | `server/src/services/ticketService.js:44-47` | **N+1 Database Queries on Ticket List**: Comment count for each ticket is queried sequentially inside a JavaScript `for` loop. | Database connection pool exhaustion and elevated API latency under traffic. |
| **10** | **Low** | `client/src/features/tickets/TicketList.jsx:31` | **Stale UI / Missing Dependencies in Fetch Effect**: Ticket list `useEffect` only listens to `[page]`, ignoring search and filter changes. | Poor user experience where updating filters does not fetch refreshed data. |

---

## Detailed Review Findings

### 1. Cross-Tenant Data Exposure & Modification (IDOR)
- **Where it is**: `server/src/routes/tickets.js:33, 64, 77-79` and `server/src/services/ticketService.js:57-67, 89-106`.
- **What is wrong**: `getTicketById`, `assignTicket`, and `deleteTicket` query and mutate records strictly by primary key `id` without verifying that the ticket belongs to the authenticated user's `org_id`.
- **Why it matters here**: The application hosts distinct customer organisations (Northwind Trading and Cobalt Logistics) who must not see each other's data. Any authenticated user from Cobalt Logistics can view confidential tickets, customer discussions, assign Northwind tickets to themselves, or delete Northwind tickets simply by guessing or iterating ticket IDs.
- **How you would fix it**: Enforce tenant boundaries in the data layer by updating `getTicketById(id, orgId)` to include `AND t.org_id = ?`. In `assignTicket` and `deleteTicket`, verify that the ticket exists within the caller's `orgId` before performing updates or deletions, returning a 404 if not found.
- **Severity**: **Critical** (Rank 1).

---

### 2. SQL Injection in Ticket Listing via Dynamic Sorting
- **Where it is**: `server/src/services/ticketService.js:38` and `server/src/routes/tickets.js:22-23`.
- **What is wrong**: The `sortBy` and `order` query parameters are extracted directly from user requests and concatenated into the raw SQL string (`ORDER BY t.${sortBy} ${order}`) without validation or sanitization.
- **Why it matters here**: An authenticated attacker can pass arbitrary SQL expressions into `?sortBy=` or `?order=` (such as boolean-based or time-based blind SQL injection payloads) to extract sensitive data, including password hashes from the `users` table or records belonging to other organisations.
- **How you would fix it**: Implement strict server-side whitelisting for allowable sort columns (`created_at`, `updated_at`, `priority`, `status`, `id`) and directions (`ASC`, `DESC`). If an unrecognised column or direction is supplied, fall back safely to a default (`t.created_at DESC`).
- **Severity**: **Critical** (Rank 2).

---

### 3. Stored Cross-Site Scripting (XSS) in Comment Rendering
- **Where it is**: `client/src/features/tickets/TicketDetail.jsx:65`.
- **What is wrong**: Comment bodies are rendered directly into the DOM using React's unescaped `dangerouslySetInnerHTML={{ __html: c.body }}`.
- **Why it matters here**: Any requester or agent who posts a comment containing HTML or JavaScript (e.g. `<img src=x onerror="...">`) will have their script executed inside the browser of any support agent or administrator viewing the ticket. This allows attackers to steal the JWT stored in `localStorage` (`helpdesk.session`), hijack privileged sessions, or trigger unintended state-changing actions.
- **How you would fix it**: Remove `dangerouslySetInnerHTML` and render comment text safely as standard React text children (`<div>{c.body}</div>`). If rich text formatting is required in the future, integrate a dedicated sanitization library such as DOMPurify before injection.
- **Severity**: **Critical** (Rank 3).

---

### 4. Missing Role Authorization on Privileged Ticket Endpoints
- **Where it is**: `server/src/routes/tickets.js:62, 75` and `client/src/features/tickets/TicketDetail.jsx:56`.
- **What is wrong**: `DELETE /api/tickets/:id` and `PATCH /api/tickets/:id/assign` use `requireAuth` but omit `requireRole(...)`, and the client UI displays the "Claim this ticket" button to requesters.
- **Why it matters here**: According to the system specification, only administrators are permitted to delete tickets, and only agents or administrators can claim tickets. In the current implementation, any standard requester can delete tickets or assign tickets to themselves. *(Related to Finding 1, but specifically represents vertical privilege escalation within an organisation).*
- **How you would fix it**: Apply `requireRole('admin')` to the `DELETE /:id` route, apply `requireRole('agent', 'admin')` to `PATCH /:id/assign`, and conditionally hide the "Claim" button in the frontend unless `user.role === 'agent' || user.role === 'admin'`.
- **Severity**: **High** (Rank 4).

---

### 5. Pagination Offset Formula Skips Page 1
- **Where it is**: `server/src/services/ticketService.js:29`.
- **What is wrong**: Pagination offset is computed as `const offset = page * PAGE_SIZE;` where default `page` is `1`.
- **Why it matters here**: Requesting page 1 results in `OFFSET 20`, which skips the first 20 records in the database. When users log in and view the ticket list, the most recently created tickets are completely invisible.
- **How you would fix it**: Change the offset calculation to `const pageNum = Math.max(1, Number(page) || 1); const offset = (pageNum - 1) * PAGE_SIZE;`.
- **Severity**: **High** (Rank 5).

---

### 6. Account Takeover & Plaintext Password Storage on Invite Accept
- **Where it is**: `server/src/routes/auth.js:44-50`.
- **What is wrong**: The `/api/auth/invite/accept` endpoint takes an unauthenticated `userId` and writes the incoming password directly into the `password_hash` column without verifying a signed token or hashing the password.
- **Why it matters here**: An unauthenticated attacker can reset any user's password (including administrators) simply by passing their `userId`. Furthermore, storing unhashed plaintext passwords breaks the `bcrypt.compare` verification in the login route, permanently locking legitimate users out of their accounts.
- **How you would fix it**: Issue a cryptographically signed, single-use invite token (e.g., JWT with expiration and purpose claim), verify the token before accepting password updates, and hash the new password using `bcrypt.hash(password, 10)` before persisting to the database.
- **Severity**: High (Rank 6).

---

### 7. Internal Agent Notes Leaked to Requesters
- **Where it is**: `server/src/services/ticketService.js:69-78` and `server/src/routes/comments.js:24`.
- **What is wrong**: `listComments` returns all comment rows including internal agent notes (`is_internal = 1`) to all users, and comment creation allows any user to post internal comments.
- **Why it matters here**: End-customer requesters can see private internal discussions, triage notes, and sensitive technical deliberations intended solely for support staff.
- **How you would fix it**: Pass the requesting user's role into `listComments(ticketId, userRole)` and filter `AND c.is_internal = 0` when the caller is a `requester`. Restrict setting `isInternal: true` on creation to `agent` and `admin` roles only.
- **Severity**: Medium (Rank 7).

---

### 8. Concurrency Race Condition (TOCTOU) on Ticket Claim
- **Where it is**: `server/src/services/ticketService.js:93-100`.
- **What is wrong**: `assignTicket` checks `if (ticket.assignee_id)` in application code before issuing an `UPDATE` statement in a separate database query.
- **Why it matters here**: If two agents attempt to claim an unassigned ticket simultaneously, both can pass the application check, resulting in a race condition where the second agent overwrites the first without conflict notification.
- **How you would fix it**: Use an atomic conditional update query: `UPDATE tickets SET assignee_id = ?, status = 'pending' WHERE id = ? AND assignee_id IS NULL` and check `result.affectedRows === 0` to detect and return assignment conflicts.
- **Severity**: Medium (Rank 8).

---

### 9. N+1 Database Queries on Ticket List View
- **Where it is**: `server/src/services/ticketService.js:44-47`.
- **What is wrong**: `listTickets` loops over all retrieved ticket rows and executes an individual `SELECT COUNT(*) AS c FROM comments WHERE ticket_id = ?` query for each ticket.
- **Why it matters here**: Rendering a single page of 20 tickets triggers 21 separate database queries sequentially. Under production load, this causes connection pool contention and degraded API throughput.
- **How you would fix it**: Replace the sequential loop with a single SQL query using a `LEFT JOIN` on a grouped comment subquery or retrieve all counts in one round trip using `SELECT ticket_id, COUNT(*) FROM comments WHERE ticket_id IN (...) GROUP BY ticket_id`.
- **Severity**: Medium (Rank 9).

---

### 10. Stale UI / Missing Dependencies in Fetch Effect
- **Where it is**: `client/src/features/tickets/TicketList.jsx:31`.
- **What is wrong**: The `useEffect` hook that fetches tickets only includes `[page]` in its dependency array, while reading `search`, `status`, `priority`, and `sortBy` from component state.
- **Why it matters here**: When a user types in the search box or changes the status, priority, or sort dropdowns, no API request is triggered; results remain stale until the user manually changes pages.
- **How you would fix it**: Include `[page, search, status, priority, sortBy]` in the dependency array (with debouncing for search input) and reset `page` to 1 whenever any filter changes.
- **Severity**: Low (Rank 10).

---

## Action Plan: Fixing the Top Five Findings

As instructed by the exercise brief, only the top five highest-ranked findings will be implemented in code. Findings 6 through 10 remain documented above for triage but left untouched to avoid unnecessary refactoring:

1. **Fix 1 (Rank 1)**: Scope ticket retrieval, assignment, and deletion by `orgId` to ensure multi-tenant data isolation.
2. **Fix 2 (Rank 2)**: Whitelist allowed sort columns and sort directions to eliminate SQL injection vulnerabilities.
3. **Fix 3 (Rank 3)**: Replace `dangerouslySetInnerHTML` with safe text rendering in the comment component to prevent stored XSS.
4. **Fix 4 (Rank 4)**: Enforce `requireRole` middleware on ticket deletion (`admin`) and assignment (`agent`, `admin`), and restrict the frontend claim button.
5. **Fix 5 (Rank 5)**: Correct pagination offset formula to properly display page 1 records.
