"""Offline date resolution and extended request contract regression tests."""
import unittest
from unittest.mock import patch
from backend.app import create_app
from backend.dates import reference_time, resolve_date

BASE = dict(type='assignment', course='程序设计', title='报告', content='提交报告', deadline=None, deadlineText='', confidence=0.9)


class DateTests(unittest.TestCase):
    def resolve(self, text, reference='2026-11-24T23:30:00+08:00'):
        return resolve_date(dict(BASE, deadlineText=text), reference_time(reference))

    def test_times(self):
        cases = {
            '2026年11月28日20:00前': '2026-11-28T20:00:00+08:00',
            '11月28日下午三点半前': '2026-11-28T15:30:00+08:00',
            '今天晚上八点前': '2026-11-24T20:00:00+08:00',
            '明天上午九点前': '2026-11-25T09:00:00+08:00',
            '本周五20:00前': '2026-11-27T20:00:00+08:00',
            '下周一下午两点前': '2026-11-30T14:00:00+08:00',
            '2028-02-29 08:15': '2028-02-29T08:15:00+08:00',
            '明天下午三点一刻': '2026-11-25T15:15:00+08:00',
            '明天20:00:30': '2026-11-25T20:00:30+08:00',
            '明天凌晨零点': '2026-11-25T00:00:00+08:00',
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                result = self.resolve(text)
                self.assertEqual(result['deadline'], expected)
                self.assertIsNone(result['deadlineDate'])
                self.assertEqual(result['deadlineText'], text)

    def test_date_only_and_ambiguity(self):
        for text, date in [('明天', '2026-11-25'), ('11月28日前', '2026-11-28'), ('下周日', '2026-12-06')]:
            result = self.resolve(text)
            self.assertIsNone(result['deadline'])
            self.assertEqual(result['deadlineDate'], date)
        for text in ['明天八点前', '11月底', '2026年2月30日', '11月28日或11月29日', '明天下午25点', '明天晚上十二点']:
            result = self.resolve(text)
            self.assertIsNone(result['deadline'])
            self.assertTrue(result['dateWarning'])
        self.assertTrue(self.resolve('1月3日前')['dateWarning'])
        self.assertEqual(self.resolve('明天', '2026-12-31T23:00:00+08:00')['deadlineDate'], '2027-01-01')
        self.assertEqual(self.resolve('今天', '2026-11-24T20:00:00Z')['deadlineDate'], '2026-11-25')
        foreign = resolve_date(dict(BASE, deadlineText='明天20:00'), reference_time('2026-11-24T20:00:00Z'), '东京当地时间明天20:00')
        self.assertIsNone(foreign['deadline'])
        self.assertTrue(foreign['dateWarning'])

    def test_incomplete_calendar_suggestions(self):
        cases = [
            ('24号晚上8点前', '2026-11-24T10:00:00+08:00', '', '2026-11-24T20:00:00+08:00', None),
            ('28号之前', '2026-11-24T10:00:00+08:00', '', None, '2026-11-28'),
            ('3号', '2026-11-24T10:00:00+08:00', '3号交作业', None, '2026-12-03'),
            ('3号', '2026-12-31T10:00:00+08:00', '', None, '2027-01-03'),
            ('31号', '2026-04-24T10:00:00+08:00', '', None, '2026-05-31'),
            ('29号', '2028-02-28T10:00:00+08:00', '', None, '2028-02-29'),
            ('29号', '2027-02-28T10:00:00+08:00', '', None, '2027-03-29'),
            ('2月29日', '2027-12-31T10:00:00+08:00', '', None, '2028-02-29'),
            ('12月31日', '2027-01-02T10:00:00+08:00', '', None, '2026-12-31'),
            ('1月3日', '2026-12-31T10:00:00+08:00', '', None, '2027-01-03'),
            ('24号', '2024-02-20T10:00:00+08:00', '', None, '2024-02-24'),
            ('24号', '2026-11-20T10:00:00+08:00', '2024年2月课程安排：24号提交报告', None, '2024-02-24'),
            ('3号', '2026-11-24T10:00:00+08:00', '12月课程安排：3号交作业', None, '2026-12-03'),
            ('3号', '2026-11-24T10:00:00+08:00', '本月3号交作业', None, '2026-11-03'),
            ('3号', '2026-12-24T10:00:00+08:00', '下个月3号交作业', None, '2027-01-03'),
        ]
        for text, reference, source, deadline, date in cases:
            with self.subTest(text=text, reference=reference, source=source):
                result = resolve_date(dict(BASE, deadlineText=text), reference_time(reference), source)
                self.assertEqual(result['deadline'], deadline)
                self.assertEqual(result['deadlineDate'], date)
                self.assertIn('推断日期，待确认', result['dateWarning'])
                self.assertEqual(result['deadlineText'], text)
        for text, source in [('32号', ''), ('0号', ''), ('3号或5号', ''), ('3号', '11月和12月：3号交作业'), ('2月30日', ''), ('29号', '2027年2月29号提交')]:
            result = resolve_date(dict(BASE, deadlineText=text), reference_time('2026-11-24T10:00:00+08:00'), source)
            self.assertIsNone(result['deadline'])
            self.assertIsNone(result['deadlineDate'])
            self.assertTrue(result['dateWarning'])

    @patch('backend.app.call_deepseek')
    def test_inferred_api_contract(self, model):
        client = create_app({'TESTING': True}).test_client()
        model.return_value = dict(BASE, deadlineText='3号')
        reply = client.post('/api/extract', json={'content': '3号交作业', 'referenceTime': '2026-12-31T10:00:00+08:00'})
        self.assertEqual(reply.status_code, 200)
        self.assertEqual(reply.json['data']['deadlineDate'], '2027-01-03')
        self.assertIn('推断日期，待确认', reply.json['data']['dateWarning'])
        self.assertIsNone(reply.json['data']['deadline'])

    @patch('backend.app.call_deepseek')
    def test_contract_and_limits(self, model):
        client = create_app({'TESTING': True}).test_client()
        model.return_value = dict(BASE, deadlineText='明天')
        reply = client.post('/api/extract', json={'content': '明天提交', 'referenceTime': '2026-11-24T12:00:00+08:00'})
        self.assertEqual(reply.status_code, 200)
        self.assertEqual(reply.json['data']['deadlineDate'], '2026-11-25')
        self.assertEqual(reply.json['data']['content'], '提交报告')
        for invalid in ['2026-02-30T10:00:00+08:00', '2026-11-24', None]:
            self.assertEqual(client.post('/api/extract', json={'content': '通知', 'referenceTime': invalid}).status_code, 400)
        for char in ['中', '😀']:
            self.assertEqual(client.post('/api/extract', json={'content': char * 10000}).status_code, 200)
            self.assertEqual(client.post('/api/extract', json={'content': char * 10001}).status_code, 400)


if __name__ == '__main__':
    unittest.main()
