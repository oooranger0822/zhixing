"""Conservative campus date resolution; never invent a missing clock time."""
import re
from datetime import datetime, timedelta, timezone

BEIJING = timezone(timedelta(hours=8))


def reference_time(value):
    if not isinstance(value, str):
        raise ValueError('referenceTime must be an aware ISO timestamp')
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('referenceTime requires timezone')
    return result.astimezone(BEIJING)


def number(text):
    if text.isdigit():
        return int(text)
    digits = dict(zip('零一二三四五六七八九', range(10)))
    if text == '两':
        return 2
    if '十' in text:
        a, b = text.split('十')
        return (digits.get(a, 1) * 10) + digits.get(b, 0)
    return digits.get(text, -1)


def infer_calendar(year, month, day, reference, source):
    """Return a suggestion and provenance; never promote omitted parts to facts."""
    if year and month:
        return datetime(int(year), int(month), day, tzinfo=BEIJING).date(), ''
    prefix = '推断日期，待确认：'
    # Only a unique calendar context is usable. Conflicting months are not guessed.
    contexts = {(int(y) if y else None, int(m)) for y, m in
                re.findall(r'(?:(\d{4})年)?(\d{1,2})月', source)}
    years = {int(y) for y in re.findall(r'(\d{4})年', source)}
    if not month:
        hints = set(re.findall(r'本月|这个月|下个月|下月|上个月|上月', source))
        offsets = {0 if h in ('本月', '这个月') else 1 if h in ('下个月', '下月') else -1 for h in hints}
        months = {m for _, m in contexts}
        context_years = {y for y, _ in contexts if y is not None}
        if len(months) > 1 or len(context_years) > 1 or len(offsets) > 1 or (contexts and offsets):
            raise ValueError('Conflicting calendar context')
        if contexts:
            month = next(iter(months))
            context_year = next(iter(context_years)) if context_years else None
            year = year or context_year
        elif offsets:
            total = reference.year * 12 + reference.month - 1 + next(iter(offsets))
            year, month = total // 12, total % 12 + 1
        else:
            if len(years) > 1:
                raise ValueError('Conflicting years')
            # Without a month context, propose the next valid occurrence, including today.
            for offset in range(13):
                total = reference.year * 12 + reference.month - 1 + offset
                y, m = total // 12, total % 12 + 1
                if years and y not in years:
                    continue
                try:
                    candidate = datetime(y, m, day, tzinfo=BEIJING).date()
                except ValueError:
                    continue
                if candidate >= reference.date():
                    reason = '原文省略年月，按参考日期建议最近有效日号'
                    if offset:
                        reason += '；本月日期已过或不存在，涉及跨月/跨年'
                    return candidate, prefix + reason + '。'
            raise ValueError('No nearby valid day')
    if not year:
        if len(years) > 1:
            raise ValueError('Conflicting years')
        year = next(iter(years)) if years else None
    if year:
        candidate = datetime(int(year), int(month), day, tzinfo=BEIJING).date()
        return candidate, prefix + '结合通知年月上下文补全；请核对是否适用于本次截止日期。'
    candidates = []
    for y in range(max(1, reference.year - 4), min(9999, reference.year + 4) + 1):
        try:
            candidates.append(datetime(y, int(month), day, tzinfo=BEIJING).date())
        except ValueError:
            continue
    if not candidates:
        raise ValueError('Invalid calendar day')
    # Nearest year avoids turning a just-passed December date into a year-long deadline.
    candidate = min(candidates, key=lambda d: (abs((d-reference.date()).days), d < reference.date()))
    return candidate, prefix + '原文省略年份，结合参考日期建议最近有效年份；请核对跨年或闰年含义。'


def resolve_date(result, reference, source=''):
    result = dict(result, deadlineDate=None, dateWarning='', referenceTime=reference.isoformat())
    text = result['deadlineText']
    if not text:
        return result
    warning = '时间存在歧义或信息不足，请人工确认。'
    if re.search(r'或|至|月底|左右|大约|预计|约莫', text):
        result.update(deadline=None, dateWarning=warning)
        return result
    # Existing validated ISO/explicit zoned times remain authoritative.
    if result['deadline']:
        return result
    result['dateWarning'] = warning
    if re.search(r'北京时间以外|美东|伦敦|UTC|GMT|纽约|东京|日本|韩国|英国|巴黎|柏林|悉尼|当地时间|时区|\b(?:EST|EDT|PST|PDT|JST|CET)\b|[+-]\d{2}:\d{2}', text + source, re.I):
        return result
    dates = []
    inference = ''
    try:
        full_matches = list(re.finditer(r'(?:(\d{4})[年/-])?(\d{1,2})[月/-](\d{1,2})(?:日|号)?', text))
        for match in full_matches:
            year, month, day = match.groups()
            candidate, inference = infer_calendar(year, month, int(day), reference, source)
            dates.append(candidate)
        for match in re.finditer(r'(?<!\d)(\d{1,2})[号日]', text):
            if any(start.start() <= match.start() < start.end() for start in full_matches):
                continue
            candidate, inference = infer_calendar(None, None, int(match[1]), reference, source or text)
            dates.append(candidate)
        for match in re.finditer(r'今天|明天|后天|(?:本|这|下)周[一二三四五六日天]', text):
            token = match.group()
            if token in ('今天', '明天', '后天'):
                dates.append((reference + timedelta(days={'今天': 0, '明天': 1, '后天': 2}[token])).date())
            else:
                weekday = '一二三四五六日天'.index(token[-1])
                weekday = min(weekday, 6)
                dates.append((reference + timedelta(days=weekday-reference.weekday()+(7 if token[0] == '下' else 0))).date())
        if len(dates) != 1:
            return result
        day = dates[0]
        clocks = list(re.finditer(r'(?:(凌晨|早上|上午|中午|下午|晚上|晚间)\s*)?(\d{1,2}|[零一二两三四五六七八九十]{1,3})(?::|：|点|时)(半|[一三]刻|\d{1,2}|[零一二三四五六七八九十]{1,3})?(?:分)?(?:(?:[:：])(\d{2}))?', text))
        result['deadlineDate'] = day.isoformat()
        result['dateWarning'] = inference
        if day < reference.date():
            result['dateWarning'] += '解析日期早于参考日期，请确认年份和日期。'
        if not clocks:
            return result
        if len(clocks) != 1:
            result['dateWarning'] += warning
            return result
        period, hour, minute, second = clocks[0].groups()
        hour = number(hour)
        minute = {'半': 30, '一刻': 15, '三刻': 45}.get(minute, number(minute) if minute else 0)
        if re.match(r'[零一二三四五六七八九十百\d刻:：]', text[clocks[0].end():]):
            result['dateWarning'] += warning
            return result
        if not period and ('点' in clocks[0].group() or '时' in clocks[0].group()) and 1 <= hour <= 12:
            result['dateWarning'] += '未明确上午或下午，请确认时刻。'
            return result
        if period and not (1 <= hour <= 12 or period == '凌晨' and hour == 0):
            result['dateWarning'] += warning
            return result
        if hour == 12 and period in ('上午', '早上', '晚上', '晚间'):
            result['dateWarning'] += '十二点的时段或跨日含义不明确，请人工确认。'
            return result
        if period in ('下午', '晚上', '晚间') and hour < 12:
            hour += 12
        if period == '中午' and hour < 11:
            result['dateWarning'] += warning
            return result
        if period == '凌晨' and hour == 12:
            hour = 0
        moment = datetime(day.year, day.month, day.day, hour, minute, int(second or 0), tzinfo=BEIJING)
        result.update(deadline=moment.isoformat(), deadlineDate=None)
        if inference and moment < reference:
            result['dateWarning'] += '建议时刻已早于参考时刻，请核对是否为历史通知。'
    except (ValueError, OverflowError):
        result.update(deadline=None, deadlineDate=None, dateWarning=warning)
    return result
