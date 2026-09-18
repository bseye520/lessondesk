FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TZ=Asia/Shanghai
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt
COPY . .
RUN mkdir -p instance static/uploads
EXPOSE 5000
CMD ["gunicorn", "-w", "1", "--threads", "8", "--timeout", "120", "--graceful-timeout", "30", "--keep-alive", "5", "--access-logfile", "-", "--access-logformat", "%(h)s %(l)s %(u)s [%(t)s] \"%(r)s\" %(s)s %(b)s %(L)ss \"%(f)s\" \"%(a)s\"", "--error-logfile", "-", "--capture-output", "--bind", "0.0.0.0:5000", "app:create_app()"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:5000/healthz', timeout=4)"
