import React from 'react';
import { describe, expect, it } from 'vitest';

import { buildChart } from '../src/chart-builder';
import {
	collectAxisValues,
	collectStackedAxisValues,
	computeNiceBarTicks,
	computeNiceDomain,
	niceNumber,
	resolveBarYAxisDomain,
	resolveYAxisDomain,
} from '../src/chart-domain';

function getYAxis(chart: React.ReactElement) {
	return React.Children.toArray(chart.props.children).find(
		(child) =>
			React.isValidElement(child) &&
			child.type &&
			(child.type as { displayName?: string }).displayName === 'YAxis',
	) as React.ReactElement | undefined;
}

describe('chart domain helpers', () => {
	describe('niceNumber', () => {
		it('keeps nice ranges unchanged', () => {
			expect(niceNumber(50_000, false)).toBe(50_000);
		});

		it('guards invalid ranges', () => {
			expect(niceNumber(0, true)).toBe(1);
			expect(niceNumber(NaN, true)).toBe(1);
		});
	});

	describe('computeNiceDomain', () => {
		it('uses a non-zero lower bound for large close values', () => {
			const domain = computeNiceDomain(1_000_000, 1_050_000);
			expect(domain[0]).toBeGreaterThan(0);
			expect(domain[0]).toBeLessThanOrEqual(1_000_000);
			expect(domain[1]).toBeGreaterThanOrEqual(1_050_000);
		});

		it('keeps zero when data starts at zero', () => {
			expect(computeNiceDomain(0, 100)[0]).toBe(0);
		});

		it('spans negative and positive values', () => {
			const [min, max] = computeNiceDomain(-50, 50);
			expect(min).toBeLessThan(0);
			expect(max).toBeGreaterThan(0);
		});

		it('pads equal values', () => {
			const [min, max] = computeNiceDomain(42, 42);
			expect(min).toBeLessThan(42);
			expect(max).toBeGreaterThan(42);
		});
	});

	describe('computeNiceBarTicks', () => {
		it('uses integer steps that cover the maximum count', () => {
			expect(computeNiceBarTicks([12, 380, 97])).toEqual([0, 100, 200, 300, 400]);
		});

		it('never creates fractional ticks for small integer counts', () => {
			const ticks = computeNiceBarTicks([1, 2, 3]);

			expect(ticks).toBeDefined();
			expect(ticks?.every(Number.isInteger)).toBe(true);
			expect(ticks?.at(-1)).toBeGreaterThanOrEqual(3);
		});

		it('keeps decimal values representable', () => {
			const ticks = computeNiceBarTicks([0.12, 0.38, 0.97]);

			expect(ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
		});

		it.each([
			{ values: [] },
			{ values: [-1, 2] },
			{ values: [1, Number.NaN] },
			{ values: [1, Number.POSITIVE_INFINITY] },
		])('returns the fallback for invalid populations: $values', ({ values }) => {
			expect(computeNiceBarTicks(values)).toBeUndefined();
		});
	});

	describe('bar chart tick integration', () => {
		it('passes generated ticks to the shared bar Y axis', () => {
			const chart = buildChart({
				data: [
					{ month: 'Jan', count: 12 },
					{ month: 'Feb', count: 380 },
					{ month: 'Mar', count: 97 },
				],
				chartType: 'bar',
				xAxisKey: 'month',
				series: [{ data_key: 'count' }],
				showDataLabels: true,
			});

			expect(getYAxis(chart)?.props.ticks).toEqual([0, 100, 200, 300, 400]);
			expect(getYAxis(chart)?.props.domain?.[1]).toBeGreaterThan(400);
		});

		it('leaves explicit and negative domains on the existing fallback', () => {
			const explicitChart = buildChart({
				data: [
					{ month: 'Jan', count: 12 },
					{ month: 'Feb', count: 380 },
				],
				chartType: 'bar',
				xAxisKey: 'month',
				series: [{ data_key: 'count' }],
				yAxisMin: 0,
				yAxisMax: 500,
			});
			const negativeChart = buildChart({
				data: [
					{ month: 'Jan', count: -12 },
					{ month: 'Feb', count: 380 },
				],
				chartType: 'bar',
				xAxisKey: 'month',
				series: [{ data_key: 'count' }],
			});

			expect(getYAxis(explicitChart)?.props.ticks).toBeUndefined();
			expect(getYAxis(negativeChart)?.props.ticks).toBeUndefined();
		});
	});

	describe('resolveYAxisDomain', () => {
		it('keeps zero-baseline charts on Recharts defaults without explicit bounds', () => {
			expect(resolveYAxisDomain(undefined, undefined, [1e6, 1.05e6], true)).toBeUndefined();
		});

		it('uses Recharts defaults for empty non-zero-baseline values', () => {
			expect(resolveYAxisDomain(undefined, undefined, [], false)).toBeUndefined();
		});

		it('auto-scales non-zero-baseline charts with values', () => {
			const domain = resolveYAxisDomain(undefined, undefined, [1e6, 1.05e6], false);
			expect(domain).toBeDefined();
			expect(domain?.[0]).toBeGreaterThan(0);
			expect(domain?.[1]).toBeGreaterThanOrEqual(1.05e6);
		});

		it('uses both explicit bounds', () => {
			expect(resolveYAxisDomain(10, 20, [1e6, 1.05e6], true)).toEqual([10, 20]);
		});

		it('uses explicit min with auto max fallback', () => {
			expect(resolveYAxisDomain(10, undefined, [], true)).toEqual([10, 'auto']);
		});

		it('uses zero lower bound with explicit max on zero-baseline charts', () => {
			expect(resolveYAxisDomain(undefined, 500, [], true)).toEqual([0, 500]);
		});

		it('expands auto max above an explicit min that exceeds the data', () => {
			const domain = resolveYAxisDomain(2000, undefined, [3, 472], false);
			expect(domain?.[0]).toBe(2000);
			expect(domain?.[1]).toBeGreaterThan(2000);
		});

		it('expands auto min below an explicit max that is below the data', () => {
			const domain = resolveYAxisDomain(undefined, 100, [1000, 2000], false);
			expect(domain?.[1]).toBe(100);
			expect(domain?.[0]).toBeLessThan(100);
		});

		it('keeps valid explicit bounds', () => {
			expect(resolveYAxisDomain(1300, 1600, [1203, 1672], false)).toEqual([1300, 1600]);
		});
	});

	describe('resolveBarYAxisDomain', () => {
		it('keeps a padded bar domain ordered when the explicit minimum exceeds the data', () => {
			const values = [500];
			const domain = resolveBarYAxisDomain(2000, undefined, values, true);

			expect(domain).toEqual(resolveYAxisDomain(2000, undefined, values, true));
			expect(Number(domain?.[0])).toBeLessThan(Number(domain?.[1]));
		});
	});

	describe('collectAxisValues', () => {
		it('collects finite numeric values across rows and keys', () => {
			expect(
				collectAxisValues(
					[
						{ a: 1, b: 'x' },
						{ a: 2, b: 3 },
					],
					['a', 'b'],
				),
			).toEqual([1, 2, 3]);
		});

		it('ignores missing cells before numeric conversion', () => {
			expect(
				collectAxisValues(
					[
						{ revenue: 1_000_000 },
						{ revenue: null },
						{ revenue: undefined },
						{ revenue: '' },
						{ revenue: '   ' },
						{ revenue: 1_050_000 },
					],
					['revenue'],
				),
			).toEqual([1_000_000, 1_050_000]);
		});
	});

	describe('collectStackedAxisValues', () => {
		it('collects rendered stack totals across rows', () => {
			const values = collectStackedAxisValues(
				[
					{ costs: 60, revenue: 50 },
					{ costs: 40, revenue: 30 },
				],
				['costs', 'revenue'],
			);

			expect(values).toEqual([110, 70]);
			expect(resolveYAxisDomain(0, undefined, values, true)).toEqual([0, 110]);
		});

		it('tracks positive and negative stack totals separately', () => {
			expect(
				collectStackedAxisValues(
					[
						{ costs: 60, refunds: -20, revenue: 50 },
						{ costs: '', refunds: null, revenue: '25' },
					],
					['costs', 'refunds', 'revenue'],
				),
			).toEqual([-20, 110, 25]);
		});
	});
});
