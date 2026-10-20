#!/bin/sh
# Read replica: clone the primary once with pg_basebackup (-R writes standby config), then run as hot standby.
set -e
export PGDATA=/var/lib/postgresql/18/docker
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  mkdir -p "$PGDATA" && chown -R postgres:postgres /var/lib/postgresql && chmod 700 "$PGDATA"
  until gosu postgres pg_basebackup -h postgres -U replicator -D "$PGDATA" -R -X stream; do
    echo "waiting for primary..."; sleep 2
  done
fi
exec gosu postgres postgres -c hot_standby=on
