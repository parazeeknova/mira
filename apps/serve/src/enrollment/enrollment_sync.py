from __future__ import annotations

from enrollment.enrollment import EnrollmentSource

# Remote enrollment sync is retired alongside the R2 backend. Kept as a
# stub so imports keep working; remote sources are always empty.


def load_remote_enrollment_sources(_settings: object) -> tuple[EnrollmentSource, ...]:
    return tuple()
