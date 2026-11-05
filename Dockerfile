# The Lockstep demo page and its API, on NEAR testnet.
# With WORLD_JSON_B64 (the throwaway testnet demo accounts) it runs the demo actions;
# without it, it reads the live plans and the actions are off.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY core ./core
COPY scripts ./scripts
COPY web ./web
COPY deployments ./deployments
RUN mkdir -p web/.data && chown -R node:node web/.data
USER node
ENV NETWORK=testnet PORT=7860 NODE_ENV=production
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/world').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "web/server.js"]
