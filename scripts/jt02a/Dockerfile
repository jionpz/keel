FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

ARG GH_VERSION=2.96.0

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates curl git; \
  arch="$(dpkg --print-architecture)"; \
  archive="gh_${GH_VERSION}_linux_${arch}.tar.gz"; \
  curl -fsSLo "/tmp/${archive}" \
    "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${archive}"; \
  curl -fsSLo /tmp/gh_checksums.txt \
    "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt"; \
  cd /tmp; \
  grep " ${archive}$" gh_checksums.txt | sha256sum -c -; \
  tar -xzf "${archive}"; \
  install -m 0755 "gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh; \
  rm -f /tmp/gh_*.tar.gz /tmp/gh_checksums.txt; \
  find "/tmp/gh_${GH_VERSION}_linux_${arch}" -depth -delete; \
  apt-get clean; \
  find /var/lib/apt/lists -mindepth 1 -depth -delete; \
  git --version; \
  gh --version
