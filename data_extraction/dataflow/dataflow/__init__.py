"""Data-flow extraction for the ICON model (Fortran + C++/Kokkos).

The package is intentionally split so that the expensive, embarrassingly
parallel part (preprocess + parse + per-file facts) can run in worker
processes and be cached, while all global analysis runs on small fact
dictionaries.
"""

__version__ = "0.4.3"
