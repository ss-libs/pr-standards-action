# Team Coding Standards

This document defines team coding standards used by the automated PR standards checker to provide feedback on pull requests. Replace or extend this file with your team's own standards.

---

## 1. Code Quality Standards

### Naming Conventions

- **Use meaningful variable names**: Avoid generic or unclear names
- **Use consistent casing**: Follow the conventions of your language and codebase (e.g. camelCase for JS/TS variables and files)
- **Plural endpoint names**: Use plural forms for resource names (e.g. `/users` not `/user`)
- **Descriptive function names**: Names should clearly indicate what a function does
- **Constants over magic values**: Create named constants instead of hardcoding values

### Code Organization

- **Remove commented code**: Don't leave commented-out code in PRs
- **Keep related code together**: Group related logic cohesively
- **Follow the project's directory conventions**: Put code in the appropriate layer (controllers, services, models, workers, etc.)
- **Use consistent file naming**: Follow the project's file naming conventions
- **Avoid code duplication**: Reuse existing code where possible
- **Use logging, not console.log**: Use a proper logger instead of `console.log`

### Linting and Formatting

- **Lint all files**: Code should pass the project's linting rules

### TypeScript Standards

- **All new code must use TypeScript**: No new `.js` files — use `.ts`/`.tsx` exclusively
- **Avoid `any`**: Use specific types, `unknown`, union types, or generics
- **Type all function parameters and return values**: Every function should have explicit type annotations
- **Use type inference appropriately**: Let TypeScript infer simple types; explicitly annotate complex ones

---

## 2. Security Standards

### Authentication and Authorization

- **Use proper authentication middleware**: Follow established auth patterns in the project
- **Implement permissions correctly**: Use the project's authorization system; never skip permission checks
- **Don't hardcode IDs or secrets**: IDs and credentials must never be hardcoded
- **Secure token handling**: Never expose sensitive tokens to clients unnecessarily
- **Use proper user context**: Derive the current user from the session/request context; don't rely on client-supplied values

### SQL Injection Prevention

- **Use parameterized queries**: Never concatenate user input directly into SQL strings — use query builder bindings or prepared statements

### Data Access Control

- **Scope queries to the authenticated user**: Ensure data access is filtered by org, project, or user where applicable
- **Don't bypass authorization checks**: Every data-modifying endpoint must verify the caller has permission

---

## 3. Database Standards

### Query Optimization

- **Avoid N+1 queries**: Use bulk/batch operations instead of per-item queries in loops
- **Compute aggregations in the database**: Let the DB handle counts and sums rather than loading data into application memory
- **Be mindful of memory usage**: Don't load entire large tables into memory

### Database Design

- **Use appropriate primary keys**: Follow the project's conventions for key generation
- **Set nullability correctly**: Make fields nullable only when a missing value is a valid state
- **Use consistent naming**: Follow existing field and table naming conventions
- **Store IDs, not names**: Use foreign keys (IDs) for relationships, not denormalized names

### Transactions

- **Use transactions for multi-step writes**: Ensure atomicity across related operations
- **Don't use transactions unnecessarily**: Single-row updates don't need explicit transactions
- **Always clean up transactions**: Use try/catch/finally to guarantee commit or rollback

---

## 4. API Standards

### Error Handling

- **Use appropriate HTTP status codes**: Match status codes to the actual error condition
- **Provide descriptive error messages**: Errors should explain what went wrong
- **Handle errors gracefully**: Wrap operations that can fail in try/catch

### Internationalization (i18n)

- **Use i18n for all user-facing messages**: Never hardcode strings shown to end users
- **Support locale headers**: Respect `Accept-Language` from the client

### Response Formats

- **Return raw data**: Let the frontend decide presentation; avoid server-side formatting of display values
- **Use consistent data structures**: Follow established response shapes in the codebase

### Validators

- **Validate all endpoint inputs**: Every route must validate its request parameters, query, and body
- **Mark required fields**: Explicitly declare which fields are mandatory

---

## 5. Performance Standards

### Algorithm Complexity

- **Prefer O(1) over O(N) operations**: Use set-based or bulk operations instead of per-item loops
- **Batch external calls**: Use batch/bulk APIs where available instead of individual requests
- **Paginate large result sets**: Never return unbounded lists from endpoints

### Scalability

- **Design for realistic data volumes**: Consider behavior at 10k+ records
- **Use pagination/chunking for large datasets**: Process results in chunks, not all at once
- **Use bulk insert/update/delete**: Avoid per-row database operations in loops

### Background Jobs

- **Use background jobs for long-running work**: Don't block API responses with slow operations

---

## 6. Testing Standards

- **Cover edge cases**: Tests should cover deleted entities, duplicates, permission boundaries, and error paths
- **Follow existing test patterns**: Maintain consistency with the project's test structure and conventions

---

## 7. Documentation Standards

### Code Comments

- **Document non-obvious logic**: Add comments for complex algorithms and business rules
- **Use JSDoc for public APIs**: Document parameters, return values, and side effects on exported functions
- **Use TODOs with tracking references**: Format: `// TODO #<issue-number>: description`

---

## 8. Data Migration Standards

### Data Preservation

- **Never lose data**: Migrations must preserve all existing records
- **Handle duplicates gracefully**: Account for pre-existing data when inserting

### Backward Compatibility

- **Don't rename existing values**: Add new enum values instead of renaming; keep old ones for compatibility
- **Keep migration order consistent**: Timestamps must be strictly sequential

---

## 9. General Best Practices

### Code Reusability

- **Use existing helpers**: Don't reimplement functionality that already exists in the codebase
- **Design for reusability**: Extract generic logic into shared utilities

### Default Values

- **Use sensible defaults**: Prefer safe, user-friendly defaults
- **Let the database set timestamps**: Don't pass timestamps from the frontend when the DB can generate them

### API Design

- **Follow REST conventions**: Use PATCH for partial updates, POST for creation, DELETE for removal
- **No verbs in URL paths**: Use HTTP methods to express intent, not URL segments
  - Bad: `POST /api/users/create`, `GET /api/items/getById/123`
  - Good: `POST /api/users`, `GET /api/items/123`

### File Upload Patterns

- **No direct file uploads to the server**: Use pre-signed URLs for browser-to-storage uploads (e.g. S3, GCS)
- **No local filesystem dependencies**: Code must work in containerized environments without persistent local storage; use environment variables, cloud storage, or databases

### Infrastructure Compatibility

- **Write container-friendly code**: No assumptions about filesystem persistence across restarts
- **Use shared state stores**: Use Redis, a database, or cloud storage for any state shared across instances

---

## Summary

These standards focus on measurable, code-verifiable quality:

- **Security**: Injection prevention, proper auth, no hardcoded secrets
- **Performance**: Efficient algorithms, N+1 prevention, background jobs
- **Data Integrity**: Safe migrations, duplicate handling, transactional writes
- **Maintainability**: Clear naming, proper organization, no commented code
- **Scalability**: Memory-conscious design, pagination, bulk operations
- **Code Quality**: Consistent patterns, reuse, proper abstractions
