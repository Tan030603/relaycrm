#!/bin/sh
# First start of the primary only: allow the replica to stream WAL.
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
