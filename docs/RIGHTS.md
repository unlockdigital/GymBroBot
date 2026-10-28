# Redistribution inventory

| Material | Public-core handling | Evidence and release condition |
|---|---|---|
| Application, UI, routes and planner | Existing ISC notices retained | Source lineage and Git author review found owner account aliases and automated agents, with no outside human contributor identified. The project maintainer supplies the existing license; any separately assigned or commissioned material needs its own record |
| 36 seed exercise entries | Generic labels, equipment and movement metadata declared authored in `runtime/catalog.cjs` | Original six entries have separate audit provenance; direct review of the expanded source found generic labels/tags without prose or media and no external author/source. New entries need their own recorded source |
| Owner-authored catalog additions | Private instance data | Included in the owner's backups, outside public source and CI fixtures |
| Private exercise corpus, preparation/PT hooks and GIFs | Excluded from public selection | Separate private configuration/provider and separate rights decision before redistribution |
| PNG app icons | Project geometric assets | Existing generator reproduces both included files byte-for-byte; no external image input found in that provenance |
| npm and native SQLite | Source/lockfile plus required notices | Current runtime notices and build component inventory retained; regenerate on dependency changes |
| Caddy and compiled Go modules | Patched source build with modification and third-party notices | Checksum-pinned source graph, compiled-package inventory and notices retained in the proxy image |
| Node, Python and Debian runtime | Referenced source/image packages | Preserve applicable image/package notices and exact package inventory with the release SBOM |
| Synthetic public CA certificate | Test trust anchor only | No private signing key included |
| Real workout records, screenshots, telemetry and operational reports | Excluded | Used only in private isolated rehearsals; regressions published with synthetic fixtures |

The repository carries the existing ISC license. Third-party components retain their own terms and notices. A metadata provenance check does not authorize redistributing an unrelated exercise database or media library. New files and historical snapshots pass the same source, privacy and rights review as the current tree.
