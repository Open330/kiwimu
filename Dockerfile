FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY --chown=bun:bun src/ ./src/
COPY --chown=bun:bun bin/ ./bin/
COPY --chown=bun:bun personas/ ./personas/
COPY --chown=bun:bun assets/ ./assets/

# Create the persistent project directory for the unprivileged runtime user.
RUN mkdir -p /data/wiki && chown -R bun:bun /data/wiki

# Expose port
EXPOSE 8000

# Health check (using bun fetch instead of curl — not available in bun image)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD bun -e "fetch('http://localhost:8000/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

WORKDIR /data/wiki
USER bun

# Initialize an empty volume deterministically, repair a missing static build,
# then replace the shell with the server so container signals are propagated.
CMD ["sh", "-c", "if [ ! -f kiwi.toml ]; then bun run /app/src/index.ts init 'Kiwi Mu Demo' --demo --no-serve; elif [ ! -f _site/index.html ]; then bun run /app/src/index.ts build; fi && exec bun run /app/src/index.ts serve -p 8000 --host 0.0.0.0"]
