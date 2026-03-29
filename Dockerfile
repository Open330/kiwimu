FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ ./src/
COPY bin/ ./bin/
COPY personas/ ./personas/
COPY assets/ ./assets/

# Create data directory for wiki projects
RUN mkdir -p /data/wiki

# Init demo data (timeout kills the auto-started server after build completes)
RUN cd /data/wiki && timeout 10 bun run /app/src/index.ts init "Kiwi Mu Demo" --demo 2>/dev/null || true

# Copy logo to static dir (buildSite may not find it during init)
RUN cp /app/assets/logos/logo_2_minimalist_icon_transparent.png /data/wiki/_site/static/logo.png 2>/dev/null || true

# Expose port
EXPOSE 8000

# Health check (using bun fetch instead of curl — not available in bun image)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD bun -e "fetch('http://localhost:8000/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

WORKDIR /data/wiki

# Run kiwimu serve from wiki project directory
CMD ["sh", "-c", "if [ ! -f /data/wiki/kiwi.toml ]; then cd /data/wiki && timeout 10 bun run /app/src/index.ts init 'Kiwi Mu Demo' --demo 2>/dev/null || true; fi && cp /app/assets/logos/logo_2_minimalist_icon_transparent.png /data/wiki/_site/static/logo.png 2>/dev/null || true && bun run /app/src/index.ts serve -p 8000 --host 0.0.0.0"]
