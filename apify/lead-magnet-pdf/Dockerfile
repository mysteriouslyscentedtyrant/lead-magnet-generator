# Debian image with Google Chrome and Puppeteer preinstalled (Node.js 24).
FROM apify/actor-node-puppeteer-chrome:24

COPY --chown=myuser:myuser package*.json ./
RUN npm --quiet set progress=false \
 && npm install --omit=dev --omit=optional \
 && echo "Node.js version:" && node --version \
 && rm -r ~/.npm

COPY --chown=myuser:myuser . ./
CMD ["npm", "start", "--silent"]
