createuser -d ldacapi
psql -c "ALTER USER ldacapi PASSWORD 'ldacapi';"
createdb -O ldacapi ldacapi