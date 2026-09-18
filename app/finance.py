"""财务：看板/流水/支出"""
from flask import (Blueprint, render_template, request, redirect, url_for,
                   flash)
from flask_login import current_user

from .models import (db, Campus, PaymentRecord, Student, CampusExpense, bj_today)
from .decorators import roles
from .utils import money_cents, log_op

bp = Blueprint('finance', __name__)


def _scope():
    return None if current_user.role == 'super_admin' else current_user.campus_id


@bp.route('/finance')
@roles('manager', 'super_admin')
def dashboard():
    s = _scope()
    qp = PaymentRecord.query
    qe = CampusExpense.query
    if s:
        qp = qp.filter_by(campus_id=s)
        qe = qe.filter_by(campus_id=s)
    # 仅交费记录（金额只作备注，不参与统计）
    charges = qp.filter(PaymentRecord.type == 'charge').order_by(
        PaymentRecord.created_at.desc()).limit(300).all()
    adjustments = qp.filter(PaymentRecord.type == 'adjust').order_by(
        PaymentRecord.created_at.desc()).limit(100).all()
    expenses = qe.order_by(CampusExpense.created_at.desc()).limit(200).all()
    # 组装统一流水（交费/调整/支出）
    rows = []
    for p in charges:
        st = db.session.get(Student, p.student_id)
        rows.append({'kind': '交费', 'who': st.name if st else '?',
                     'lessons': p.lessons_delta, 'bonus': p.lessons_bonus,
                     'amount_cents': p.amount_cents,
                     'date': p.created_at, 'remarks': p.remarks,
                     'operator': p.operator.username if p.operator else ''})
    for p in adjustments:
        st = db.session.get(Student, p.student_id)
        rows.append({'kind': '调整' if p.lessons_delta >= 0 else '扣减',
                     'who': st.name if st else '?',
                     'lessons': p.lessons_delta, 'bonus': 0,
                     'amount_cents': p.amount_cents,
                     'date': p.created_at, 'remarks': p.remarks,
                     'operator': p.operator.username if p.operator else ''})
    for e in expenses:
        rows.append({'kind': '支出', 'who': e.category,
                     'lessons': 0, 'bonus': 0,
                     'amount_cents': -e.amount_cents,
                     'date': e.created_at, 'remarks': e.remarks,
                     'operator': e.operator.username if e.operator else ''})
    rows.sort(key=lambda r: r['date'], reverse=True)
    # 汇总卡（仅计数与节数，不算金额）
    total_charge_lessons = sum(r['lessons'] for r in rows if r['kind'] == '交费')
    total_bonus = sum(r['bonus'] for r in rows if r['kind'] == '交费')
    expense_count = sum(1 for r in rows if r['kind'] == '支出')
    campuses = Campus.query.all()
    return render_template('finance.html', rows=rows[:300],
                           total_charge_lessons=total_charge_lessons,
                           total_bonus=total_bonus, expense_count=expense_count,
                           campuses=campuses)


@bp.route('/finance/expense', methods=['POST'])
@roles('manager', 'super_admin')
def expense():
    s = _scope() or request.form.get('campus_id', type=int)
    category = request.form.get('category') or '其他'
    amount = money_cents(request.form.get('amount') or '')
    remarks = (request.form.get('remarks') or '').strip()
    if not db.session.get(Campus, s):
        flash('校区无效', 'danger')
    elif amount is None or amount <= 0:
        flash('金额不合法', 'danger')
    elif not remarks:
        flash('支出必须填写说明', 'danger')
    else:
        e = CampusExpense(campus_id=s, category=category, amount_cents=amount,
                          remarks=remarks, operator_id=current_user.id)
        db.session.add(e)
        db.session.flush()
        log_op(current_user.id, 'campus_expense', e.id, 'create',
               f'{category} {amount // 100}元 {remarks}')
        db.session.commit()
        flash('支出已记录', 'success')
    return redirect(url_for('finance.dashboard'))
