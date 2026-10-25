# PGSync, pinned to an exact PyPI release, with one upstream bug fixed.
#
# Upstream publishes only a moving `latest` tag, which can carry unreleased
# code, so the version is pinned here and in requirements.txt (the release's
# own requirements/base.txt). The image matches upstream's layout: Python 3.12,
# entrypoint `pgsync`, user `pgsync`.
FROM python:3.12-slim

ARG PGSYNC_VERSION=7.3.0

WORKDIR /app
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
 && pip install --no-cache-dir --no-deps "pgsync==${PGSYNC_VERSION}"

# Upstream bug: Sync.setup() assigns node_columns[node.table] once per node, so
# a table that appears in several nodes of schema.json keeps only the last
# node's columns. Its trigger then ignores updates to every other indexed column
# (a meeting release, a Greek name). Merge the columns of every node instead.
# The build fails if the line it patches is not there.
RUN f=$(python -c "import os, pgsync; print(os.path.join(os.path.dirname(pgsync.__file__), 'sync.py'))") \
 && test "$(grep -c 'node_columns\[node.table\] = set(' "$f")" = 1 \
 && sed -i 's/node_columns\[node.table\] = set(/node_columns.setdefault(node.table, set()).update(/' "$f" \
 && grep -q 'node_columns.setdefault(node.table, set()).update(' "$f" \
 && python -m py_compile "$f"

RUN useradd --create-home pgsync && chown -R pgsync /app
USER pgsync
ENTRYPOINT ["pgsync"]
