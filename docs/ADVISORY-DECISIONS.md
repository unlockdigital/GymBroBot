# High-advisory decisions

Review date: October 28, 2026. Review expires November 11, 2026. The findings remain in raw scans; these are applicability decisions for a bounded deployment, not claims that every affected package has been patched.

## Checked baseline

The reviewed candidate is core `81bd296` plus the security surface patch that removes mount, umount, nsenter and infocmp. Its tested Linux amd64 app image is `sha256:02e5d6fe197a9303b1d9fcda411436148256f01bba8897e4448887f9d3920fd2`. It uses the checked Compose profile and no additional executable private hooks. All thirteen native suites and the synthetic app/proxy/backup-restore rehearsal passed. The final release must bind the reviewed decision to its exact source and built image after integration.

## Individual findings

| Advisory | Disposition | Checked reason |
|---|---|---|
| [CVE-2026-76642](https://security-tracker.debian.org/tracker/CVE-2026-76642) | vulnerable code not in execute path | Mount helper/post-hook privilege escalation requires privileged mount execution. The candidate removes mount/umount; operations never call libmount. The serving process has zero effective capabilities. |
| [CVE-2026-78408](https://security-tracker.debian.org/tracker/CVE-2026-78408) | vulnerable code not present | The flawed nsenter executable is removed. Operations never invoke nsenter or accept an inherited root-opened cgroup migration descriptor. Container PID/cgroup namespaces and mounts stay isolated. |
| [CVE-2026-78409](https://security-tracker.debian.org/tracker/CVE-2026-78409) | vulnerable code not in execute path | The candidate removes mount and exposes no libmount API. The exploit needs a privileged fstab-authorized X-mount.subdir path, attacker-controlled source and Linux >=6.15. Upstream lists >=2.42 while Debian flags 2.41.5; retain the distro finding and resolve by missing path. |
| [CVE-2026-78410](https://security-tracker.debian.org/tracker/CVE-2026-78410) | vulnerable code not in execute path | Restricted bind-mount pathname replacement needs privileged mount plus fstab X-mount.owner/group/mode hooks. The candidate removes mount and umount; trusted operations never execute this path. |
| [CVE-2026-54369](https://security-tracker.debian.org/tracker/CVE-2026-54369) | vulnerable code not in execute path | libacl1 remains installed for OS compatibility. Python operations use SQLite backup, byte copy, chown and chmod on fixed private paths; they never call acl_*_file APIs or launch ACL-preserving utilities. Node serves as UID1000 with zero capabilities. Root init-volumes performs only fixed-path chown/chmod/makedirs, without ACL calls or untrusted requests. |
| [CVE-2025-69720](https://security-tracker.debian.org/tracker/CVE-2025-69720) | vulnerable code not present | The vulnerable analyze_string implementation belongs to infocmp. The candidate removes that executable. Retained ncurses libraries/terminfo data do not contain that command implementation. |
| [CVE-2026-15308](https://security-tracker.debian.org/tracker/CVE-2026-15308) | vulnerable code not in execute path | Repeated incremental HTMLParser.feed on hostile declarations causes the flaw. ops.py and its loaded import closure contain no html parser. Browser HTML uses browser/JavaScript paths. Python reads local JSON/SQLite/files only. |
| [CVE-2026-19445](https://security-tracker.debian.org/tracker/CVE-2026-19445) | vulnerable code not in execute path | Python never imports ssl/_ssl or opens a TLS server, and defines no SNI callback/context switch. Caddy terminates TLS; app communication uses Unix sockets. Network-none reinforces this separate code-path evidence. |
| [CVE-2026-19553](https://security-tracker.debian.org/tracker/CVE-2026-19553) | vulnerable code not in execute path | Python never imports ssl/asyncio or calls wrap_bio, create_connection or start_tls. Caddy handles TLS; no Python hostname-verification path processes remote traffic. |
| [CVE-2026-7210](https://security-tracker.debian.org/tracker/CVE-2026-7210) | vulnerable code not in execute path | Python imports no XML, pyexpat or ElementTree module and parses no XML. Installed libexpat is >=2.8.0, but the separate Python hash-salt fix remains absent; the libexpat version alone establishes only partial remediation. |
| [CVE-2026-82049](https://security-tracker.debian.org/tracker/CVE-2026-82049) | vulnerable code not in execute path | ops.py never imports tarfile or extracts an archive. Its backup/restore copies four named regular files and SQLite snapshots with symlink/empty-volume checks. shutil does not load tarfile along the exercised operations import closure. |
| [CVE-2026-16742](https://security-tracker.debian.org/tracker/CVE-2026-16742) | vulnerable code not present | Only libsystemd0/libudev1 shared libraries are installed. systemd-homed executable/service and a homed-managed user are absent. Source-package matching creates the retained rows; affected home-record authentication code is absent. |
| [CVE-2026-9538](https://security-tracker.debian.org/tracker/CVE-2026-9538) | vulnerable code not present | perl-base is installed, while Archive/Tar.pm is absent. No application or operations path invokes Perl archive parsing. GNU tar and Python tarfile are separate implementations. |

## Validity and maintenance

The serving app must retain UID1000, zero effective capabilities, no-new-privileges, a read-only root filesystem, isolated namespaces, scoped private mounts and no application network. Fixed-path root initialization is an operator-only maintenance command; it is outside the serving process profile. Private executable hooks require their own review before these exceptions can cover a deployment.

Python operations use fixed Node/SQLite/filesystem paths and do not process network TLS, HTML, XML or archives. Source/import/runtime surface checks protect those assumptions. No global scanner ignore file hides these findings. Package updates should replace an exception when a compatible vendor fix is available.

A new image, package revision, Python import, executable extension, subprocess argument path, relaxed privilege/network setting, revised advisory or fixed stable package triggers immediate review. Expiry blocks carrying the decision into a later release without rechecking. Medium/low/unknown findings remain in the release inventory for maintenance.

[Machine-readable decisions](ADVISORY-DECISIONS.json) retain installed revisions, vendor remedies, ownership, expiry and triggers. The private review bundle retains exact scan/native/vendor evidence; a distributed release must attach its reviewed public evidence and final image identities.
