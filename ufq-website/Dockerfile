# UFQ website – static site served by nginx
FROM nginx:1.27-alpine

# Our server config (gzip, caching, security headers)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Website files
COPY site/ /usr/share/nginx/html/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
