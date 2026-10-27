"""Bucket statistics: counters, resets, gaps, time weighting."""
from has.core.stats import COUNTER, MEASUREMENT, TOTAL, SeriesState, combine, compute_buckets, counter_step

H = 3600


def ms(s):
    return int(s * 1000)


def test_measurement_time_weighted_mean():
    # 10 for 15 min, 20 for 45 min -> mean 17.5 (not arithmetic 15)
    samples = [(ms(0), 10.0), (ms(900), 20.0)]
    b = compute_buckets(samples, [0, H], MEASUREMENT)[0]
    assert abs(b.mean - 17.5) < 1e-9
    assert b.min == 10 and b.max == 20
    assert b.count == 2
    assert b.covered == H


def test_measurement_carries_value_from_previous_bucket():
    samples = [(ms(100), 5.0)]
    buckets = compute_buckets(samples, [0, H, 2 * H], MEASUREMENT)
    assert buckets[1].mean == 5.0
    assert buckets[1].count == 0
    assert buckets[1].coverage == 1.0
    # first bucket only covered after first sample
    assert abs(buckets[0].covered - (H - 100)) < 1e-9


def test_unavailable_marker_creates_gap():
    samples = [(ms(0), 10.0), (ms(1800), None), (ms(3000), 30.0)]
    b = compute_buckets(samples, [0, H], MEASUREMENT)[0]
    # covered: 0-1800 (10) and 3000-3600 (30)
    assert abs(b.covered - 2400) < 1e-9
    assert abs(b.mean - (10 * 1800 + 30 * 600) / 2400) < 1e-9


def test_counter_consumption_not_sum_of_readings():
    samples = [(ms(0), 1000.0), (ms(1800), 1001.5), (ms(3599), 1002.0)]
    b = compute_buckets(samples, [0, H], COUNTER)[0]
    assert abs(b.delta - 2.0) < 1e-9


def test_counter_reset_detected():
    # meter goes 100 -> 105, resets to 0 and counts to 3 -> consumption 5 + 3
    samples = [(ms(0), 100.0), (ms(600), 105.0), (ms(1200), 0.0), (ms(1800), 3.0)]
    b = compute_buckets(samples, [0, H], COUNTER, SeriesState(value=100.0, baseline=100.0))[0]
    assert abs(b.delta - 8.0) < 1e-9


def test_counter_reset_to_nonzero():
    # reset where first reading after reset already shows 0.4
    samples = [(ms(0), 50.0), (ms(600), 0.4), (ms(1200), 1.0)]
    b = compute_buckets(samples, [0, H], COUNTER, SeriesState(value=50.0, baseline=50.0))[0]
    assert abs(b.delta - 1.0) < 1e-9


def test_counter_small_jitter_ignored_and_not_double_counted():
    samples = [(ms(0), 100.0), (ms(600), 99.95), (ms(1200), 100.2)]
    b = compute_buckets(samples, [0, H], COUNTER, SeriesState(value=100.0, baseline=100.0))[0]
    assert abs(b.delta - 0.2) < 1e-9


def test_counter_across_unavailable_gap():
    samples = [(ms(0), 10.0), (ms(600), None), (ms(H + 100), 12.0)]
    buckets = compute_buckets(samples, [0, H, 2 * H], COUNTER, SeriesState(value=10.0, baseline=10.0))
    assert buckets[0].delta == 0.0
    assert abs(buckets[1].delta - 2.0) < 1e-9  # attributed when meter reports again


def test_total_kind_allows_negative():
    samples = [(ms(0), 10.0), (ms(600), 7.0)]
    b = compute_buckets(samples, [0, H], TOTAL, SeriesState(value=10.0, baseline=10.0))[0]
    assert abs(b.delta + 3.0) < 1e-9


def test_counter_step_function():
    assert counter_step(None, 5, COUNTER) == (0.0, 5)
    assert counter_step(5, 7, COUNTER) == (2, 7)
    assert counter_step(100, 1, COUNTER) == (1, 1)  # reset


def test_duplicate_timestamps_are_harmless():
    samples = [(ms(0), 1.0), (ms(0), 1.0), (ms(1800), 3.0)]
    b = compute_buckets(samples, [0, H], MEASUREMENT)[0]
    assert abs(b.mean - 2.0) < 1e-9


def test_until_limits_extrapolation():
    samples = [(ms(0), 10.0)]
    b = compute_buckets(samples, [0, H], MEASUREMENT, until=1800)[0]
    assert b.covered == 1800


def test_combine_weighted():
    rows = [
        {"ts": 0, "mean": 10, "min": 10, "max": 10, "first": 10, "last": 10, "delta": 1, "count": 1, "covered": 3600},
        {"ts": 3600, "mean": 20, "min": 15, "max": 25, "first": 15, "last": 25, "delta": 2, "count": 2, "covered": 1800},
    ]
    b = combine(rows, [0, 7200])[0]
    assert abs(b.mean - (10 * 3600 + 20 * 1800) / 5400) < 1e-9
    assert b.min == 10 and b.max == 25 and b.delta == 3 and b.count == 3
    assert b.first == 10 and b.last == 25


def test_combine_counts_coverage_without_mean():
    rows = [{"ts": 0, "mean": None, "delta": 1.0, "count": 0, "covered": 3600},
            {"ts": 3600, "mean": None, "delta": 2.0, "count": 0, "covered": 3600}]
    b = combine(rows, [0, 7200])[0]
    assert b.coverage == 1.0 and b.delta == 3.0 and b.mean is None
