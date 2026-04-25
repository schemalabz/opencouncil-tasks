#!/bin/sh
# Fix ownership of mounted volumes that may be created by the host as root
chown -R apify:apify /app/logs /app/data 2>/dev/null || true

exec gosu apify "$@"
