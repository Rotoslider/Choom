-- Human-readable timestamp views for DB Browser
-- Prisma stores DateTime as Unix epoch milliseconds in SQLite
-- Run: npm run db:views

DROP VIEW IF EXISTS v_chooms;
CREATE VIEW v_chooms AS
SELECT *,
  strftime('%m/%d/%Y %I:%M %p', datetime(createdAt / 1000, 'unixepoch', 'localtime')) AS createdAtReadable,
  strftime('%m/%d/%Y %I:%M %p', datetime(updatedAt / 1000, 'unixepoch', 'localtime')) AS updatedAtReadable
FROM Choom;

DROP VIEW IF EXISTS v_chats;
CREATE VIEW v_chats AS
SELECT *,
  strftime('%m/%d/%Y %I:%M %p', datetime(createdAt / 1000, 'unixepoch', 'localtime')) AS createdAtReadable,
  strftime('%m/%d/%Y %I:%M %p', datetime(updatedAt / 1000, 'unixepoch', 'localtime')) AS updatedAtReadable
FROM Chat;

DROP VIEW IF EXISTS v_messages;
CREATE VIEW v_messages AS
SELECT *,
  strftime('%m/%d/%Y %I:%M %p', datetime(createdAt / 1000, 'unixepoch', 'localtime')) AS createdAtReadable
FROM Message;

DROP VIEW IF EXISTS v_generated_images;
CREATE VIEW v_generated_images AS
SELECT *,
  strftime('%m/%d/%Y %I:%M %p', datetime(createdAt / 1000, 'unixepoch', 'localtime')) AS createdAtReadable
FROM GeneratedImage;

DROP VIEW IF EXISTS v_activity_logs;
CREATE VIEW v_activity_logs AS
SELECT *,
  strftime('%m/%d/%Y %I:%M %p', datetime(createdAt / 1000, 'unixepoch', 'localtime')) AS createdAtReadable
FROM ActivityLog;

DROP VIEW IF EXISTS v_notifications;
CREATE VIEW v_notifications AS
SELECT *,
  strftime('%m/%d/%Y %I:%M %p', datetime(createdAt / 1000, 'unixepoch', 'localtime')) AS createdAtReadable
FROM Notification;
