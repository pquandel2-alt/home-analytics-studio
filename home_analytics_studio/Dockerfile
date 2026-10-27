ARG BUILD_FROM=python:3.12-alpine3.20
FROM ${BUILD_FROM}

ARG BUILD_VERSION=1.0.0
ARG BUILD_ARCH=amd64

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HAS_DATA_DIR=/data \
    HAS_STATIC_DIR=/opt/has/static \
    TZ=UTC

WORKDIR /opt/has

# Python dependencies: prebuilt wheels exist for amd64 and aarch64 (musllinux).
# A compiler toolchain is only installed as a fallback and removed afterwards.
COPY backend/requirements.txt ./requirements.txt
RUN apk add --no-cache tzdata tini \
    && (pip install --only-binary=:all: -r requirements.txt \
        || (apk add --no-cache --virtual .build-deps gcc musl-dev libffi-dev \
            && pip install -r requirements.txt \
            && apk del .build-deps))

# The web UI is shipped pre-built (frontend/dist) so that installing the add-on
# on low-power Home Assistant hardware does not require Node.js or a JS build.
COPY frontend/dist ./static
COPY backend/has ./has
COPY run.sh /run.sh
RUN chmod +x /run.sh \
    && test -f ./static/index.html \
    && python3 -m compileall -q has

LABEL io.hass.version="${BUILD_VERSION}" \
      io.hass.type="addon" \
      io.hass.arch="${BUILD_ARCH}"

EXPOSE 8099 8100
HEALTHCHECK --interval=60s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${HAS_INGRESS_PORT:-8099}/api/health" >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/run.sh"]
