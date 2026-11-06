# Continuity Scorecard v2 - sealed bench image for mnemos-mcp @ 3108e08.
#
# Base: mnemos-bench:3108e08-words = python:3.12-slim + `pip install` of the
# pinned, unmodified mnemos-mcp source (user `bench`). Build context holds only
# this adapter and the corpus files. The run is `--network none` with no mounts.
ARG BASE=mnemos-bench:3108e08-words
FROM ${BASE}
USER root
# The only package added: the clock control (C extension; patches datetime.now
# and time.time, leaves time.monotonic and perf_counter real).
RUN pip install --no-cache-dir "time-machine==2.19.0"
COPY adapter.py corpus-v2.json filler-golden.json /opt/bench/
USER bench
WORKDIR /home/bench
ENTRYPOINT ["python", "-I", "/opt/bench/adapter.py"]
