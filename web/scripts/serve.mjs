// Production startup does not depend on development-only cross-env binaries.
process.env.NODE_ENV='production';
await import('../index.js');
