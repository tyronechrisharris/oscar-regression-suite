# Security

Do not open a public issue containing OSCAR credentials, `.env`, SSH keys,
internal topology details, unreviewed screenshots, alarm exports, or result
bundles. Generated reports may contain lane, event, and vehicle information.

For a suspected vulnerability, contact the repository owner privately with the
minimum reproducible detail. Rotate any credential that may have been exposed.

The suite deliberately accepts self-signed HTTPS certificates inside an
authorized isolated test lab. That behavior is not appropriate for public or
production targets. SSH host-key verification remains strict.
