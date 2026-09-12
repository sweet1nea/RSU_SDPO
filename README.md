# RSU SDPO

**Romblon State University Sports Development Program Office Transaction Management System and Equipment Inventory with QR Code Integration**

A capstone project implementing a web-based Admin System and User System for centralized sports equipment inventory, QR-based transaction validation, borrowing/return workflow management, notifications, and administrative reporting for the SDPO.

## Tech Stack

- **Frontend:** HTML5, CSS3, Bootstrap 5, JavaScript
- **Backend:** Node.js, Express.js (MVC)
- **Database:** PostgreSQL (hosted on Supabase)
- **Auth:** Passport.js / Auth.js, JWT, Google OAuth 2.0
- **QR Code:** qrcode (generation), html5-qrcode (scanning)
- **Reports:** PDFKit/Puppeteer, ExcelJS, Chart.js
- **Notifications:** Gmail SMTP (dev and prod), Semaphore SMS
- **Deployment:** Vercel or Railway

## Project Structure

```
RSU-SDPO/
├── client/     # Frontend (HTML5, CSS3, JS, Bootstrap 5)
└── server/     # Backend (Node.js, Express.js, MVC)
```

See folder tree for full module breakdown (auth, inventory, equipment, QR, borrowing, return, damage/loss, notifications, reports, dashboard, audit logs).

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in credentials
3. Run database migrations in `server/database/migrations`
4. Seed initial data: `node server/scripts/seedDatabase.js`
5. `npm run dev` to start in development mode

## Development Team

| Role | Member |
|---|---|
| Project Leader | Laurie Jean F. Fernandez |
| Backend Developer | Ryan Norleigh F. Roxas |
| Frontend Developer | Mark Laurence T. Dioco |
| Database Developer | Mar Jhon S. Fermanejo |

## Scope

Limited to SDPO sports equipment inventory and transaction management. Excludes facility reservation, payroll, accounting, online payment processing, and integration with other university systems.
